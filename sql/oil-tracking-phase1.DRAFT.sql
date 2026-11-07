-- DRAFT ONLY. NOT APPLIED. Requires explicit owner approval and staging review.
-- Intentionally aborts the enclosing transaction before any DDL.
-- Remove this guard ONLY after approval; never execute selected fragments.
BEGIN;
DO $$ BEGIN
  RAISE EXCEPTION 'UNAPPROVED DRAFT: do not run against the real database';
END $$;

-- Independent stable identity: do not change buses or backfill repairs.
-- A plate rename/linking policy must be approved before production use.
CREATE TABLE public.fleet_oil_vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plate_snapshot TEXT UNIQUE NOT NULL,
  vehicle_type TEXT CHECK (vehicle_type IN ('bus', 'minibus', 'van')),
  revision BIGINT NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Store versioned policies, not a mutable singleton; retain the applied revision.
CREATE TABLE public.fleet_oil_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settings JSONB NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  revision BIGINT UNIQUE NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.fleet_oil_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id UUID NOT NULL REFERENCES public.fleet_oil_vehicles(id),
  kind TEXT NOT NULL CHECK (kind IN ('service', 'reading')),
  occurred_on DATE NOT NULL,
  odometer BIGINT NOT NULL CHECK (odometer BETWEEN 0 AND 100000000),
  program TEXT CHECK (program IN ('S', 'M', 'S2', 'L')),
  repair_reference TEXT,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source = 'manual'),
  supersedes UUID UNIQUE,
  correction_reason TEXT,
  created_by TEXT NOT NULL,
  actor_snapshot JSONB NOT NULL,
  event_sequence BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, vehicle_id, kind),
  FOREIGN KEY (supersedes, vehicle_id, kind)
    REFERENCES public.fleet_oil_events(id, vehicle_id, kind),
  CHECK (supersedes IS NULL OR (supersedes <> id AND coalesce(length(trim(correction_reason)), 0) > 0)),
  CHECK ((kind = 'service' AND program IS NOT NULL) OR (kind = 'reading' AND program IS NULL))
);
CREATE INDEX fleet_oil_events_vehicle_date ON public.fleet_oil_events(vehicle_id, occurred_on DESC, created_at DESC);

-- Mirrors the existing log vocabulary: action/ref, actor, timestamp + before/after.
-- Future server must insert mutation and audit in the SAME transaction.
CREATE TABLE public.fleet_oil_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_snapshot JSONB NOT NULL,
  before_value JSONB,
  after_value JSONB,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Global CAS revision serializes changes during this small-fleet first phase.
CREATE TABLE public.fleet_oil_meta (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
CREATE TABLE public.fleet_oil_requests (
  actor_id TEXT NOT NULL,
  request_id UUID NOT NULL,
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, request_id)
);

-- Bootstrap only new module metadata/defaults if this draft is ever approved.
-- No real vehicle/event data is inserted or inferred from repairs.
INSERT INTO public.fleet_oil_meta(singleton, revision) VALUES (true, 0);
INSERT INTO public.fleet_oil_policies(settings, revision, created_by) VALUES (
  '{"groups":{"bus":{"name":"รถบัสทั่วไป","km":35000,"months":6},"special":{"name":"รถบัสรอบพิเศษ","km":20000,"months":6},"minibus":{"name":"มินิบัส","km":10000,"months":6},"van":{"name":"รถตู้ปรับอากาศ","km":10000,"months":6}},"warnKm":2000,"warnDays":30,"staleDays":30}'::jsonb,
  0, 'migration-defaults'
);

CREATE FUNCTION public.fleet_oil_event_json(e public.fleet_oil_events)
RETURNS JSONB LANGUAGE SQL STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('id',e.id,'vehicleId',e.vehicle_id,'date',e.occurred_on,
    'odometer',e.odometer,'note',e.note,'supersedes',e.supersedes,
    'reason',coalesce(e.correction_reason,''),'sequence',e.event_sequence,
    'actor',e.actor_snapshot,'recordedAt',e.created_at)
    || CASE WHEN e.kind='service' THEN jsonb_build_object('program',e.program,'repairRef',coalesce(e.repair_reference,''))
       ELSE jsonb_build_object('source',e.source) END;
$$;

-- One SQL statement/snapshot: no mixed revisions across separate HTTP reads.
CREATE FUNCTION public.fleet_oil_snapshot()
RETURNS JSONB LANGUAGE SQL STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('schema',1,'revision',m.revision,
    'settings',(SELECT settings FROM public.fleet_oil_policies ORDER BY revision DESC LIMIT 1),
    'vehicles',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'plate',plate_snapshot,'type',coalesce(vehicle_type,''))) FROM public.fleet_oil_vehicles),'[]'::jsonb),
    'services',coalesce((SELECT jsonb_agg(public.fleet_oil_event_json(e)) FROM public.fleet_oil_events e WHERE kind='service'),'[]'::jsonb),
    'readings',coalesce((SELECT jsonb_agg(public.fleet_oil_event_json(e)) FROM public.fleet_oil_events e WHERE kind='reading'),'[]'::jsonb),
    'audit',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'action',action,'entityId',entity_id,
      'before',before_value,'after',after_value,'actor',actor_snapshot,'timestamp',timestamp)) FROM public.fleet_oil_audit),'[]'::jsonb))
  FROM public.fleet_oil_meta m WHERE m.singleton=true;
$$;

CREATE FUNCTION public.fleet_oil_request(p_actor_id TEXT, p_request_id UUID)
RETURNS JSONB LANGUAGE SQL STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('hash',fingerprint,'result',result) FROM public.fleet_oil_requests
    WHERE actor_id=p_actor_id AND request_id=p_request_id;
$$;

CREATE FUNCTION public.fleet_oil_commit(p_expected_revision BIGINT, p_request_id UUID,
  p_actor_id TEXT, p_hash TEXT, p_command JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  current_revision BIGINT;
  receipt public.fleet_oil_requests%ROWTYPE;
  mutation JSONB := p_command->'mutation';
  value JSONB := mutation->'value';
  audit JSONB := p_command->'audit';
BEGIN
  IF audit#>>'{actor,id}' IS DISTINCT FROM p_actor_id OR audit#>>'{actor,role}' IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('code','FORBIDDEN');
  END IF;
  SELECT revision INTO STRICT current_revision FROM public.fleet_oil_meta WHERE singleton=true FOR UPDATE;
  SELECT * INTO receipt FROM public.fleet_oil_requests WHERE actor_id=p_actor_id AND request_id=p_request_id;
  IF FOUND THEN
    IF receipt.fingerprint <> p_hash THEN RETURN jsonb_build_object('code','REQUEST_CONFLICT'); END IF;
    RETURN jsonb_build_object('result',receipt.result,'replayed',true);
  END IF;
  IF current_revision <> p_expected_revision THEN RETURN jsonb_build_object('code','REVISION_CONFLICT'); END IF;
  IF (p_command#>>'{result,revision}')::bigint IS DISTINCT FROM current_revision+1 THEN
    RETURN jsonb_build_object('code','INVALID_COMMAND');
  END IF;

  CASE mutation->>'kind'
    WHEN 'vehicle.create' THEN
      INSERT INTO public.fleet_oil_vehicles(id,plate_snapshot,vehicle_type,created_by,updated_by)
        VALUES ((value->>'id')::uuid,value->>'plate',nullif(value->>'type',''),p_actor_id,p_actor_id);
    WHEN 'vehicle.classify' THEN
      UPDATE public.fleet_oil_vehicles SET vehicle_type=nullif(value->>'type',''),
        revision=revision+1,updated_by=p_actor_id,updated_at=now() WHERE id=(value->>'id')::uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'Vehicle missing' USING ERRCODE='23503'; END IF;
    WHEN 'settings.create' THEN
      INSERT INTO public.fleet_oil_policies(id,settings,revision,created_by)
        VALUES ((mutation->>'id')::uuid,value,current_revision+1,p_actor_id);
    WHEN 'event.create' THEN
      IF coalesce(mutation->>'collection','') NOT IN ('services','readings') THEN RAISE EXCEPTION 'Invalid kind' USING ERRCODE='23514'; END IF;
      INSERT INTO public.fleet_oil_events(id,vehicle_id,kind,occurred_on,odometer,program,repair_reference,
        note,source,supersedes,correction_reason,created_by,actor_snapshot,event_sequence,created_at)
      VALUES ((value->>'id')::uuid,(value->>'vehicleId')::uuid,
        CASE WHEN mutation->>'collection'='services' THEN 'service' ELSE 'reading' END,
        (value->>'date')::date,(value->>'odometer')::bigint,value->>'program',value->>'repairRef',
        value->>'note','manual',(value->>'supersedes')::uuid,value->>'reason',p_actor_id,
        audit->'actor',current_revision+1,(value->>'recordedAt')::timestamptz);
    ELSE RAISE EXCEPTION 'Invalid mutation' USING ERRCODE='23514';
  END CASE;

  INSERT INTO public.fleet_oil_audit(id,action,entity_id,actor_id,actor_snapshot,before_value,after_value,timestamp)
    VALUES ((audit->>'id')::uuid,audit->>'action',audit->>'entityId',p_actor_id,
      audit->'actor',audit->'before',audit->'after',(audit->>'timestamp')::timestamptz);
  INSERT INTO public.fleet_oil_requests(actor_id,request_id,fingerprint,result)
    VALUES (p_actor_id,p_request_id,p_hash,p_command->'result');
  UPDATE public.fleet_oil_meta SET revision=current_revision+1 WHERE singleton=true;
  RETURN jsonb_build_object('result',p_command->'result','replayed',false);
EXCEPTION WHEN check_violation OR foreign_key_violation OR unique_violation OR invalid_text_representation THEN
  -- The exception block rolls back mutation, audit, receipt and revision together.
  RETURN jsonb_build_object('code','INVALID_COMMAND');
END;
$$;

ALTER TABLE public.fleet_oil_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_oil_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_oil_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_oil_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_oil_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_oil_requests ENABLE ROW LEVEL SECURITY;
-- No client policies: app sessions are custom signed tokens, not Supabase Auth.
REVOKE ALL ON public.fleet_oil_vehicles, public.fleet_oil_policies,
  public.fleet_oil_events, public.fleet_oil_audit, public.fleet_oil_meta, public.fleet_oil_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.fleet_oil_vehicles, public.fleet_oil_policies,
  public.fleet_oil_events, public.fleet_oil_audit, public.fleet_oil_meta, public.fleet_oil_requests FROM service_role;
GRANT SELECT, INSERT, UPDATE ON public.fleet_oil_vehicles TO service_role;
GRANT SELECT, INSERT ON public.fleet_oil_policies, public.fleet_oil_events, public.fleet_oil_audit TO service_role;
GRANT SELECT, UPDATE ON public.fleet_oil_meta TO service_role;
GRANT SELECT, INSERT ON public.fleet_oil_requests TO service_role;
REVOKE ALL ON FUNCTION public.fleet_oil_event_json(public.fleet_oil_events),
  public.fleet_oil_snapshot(),public.fleet_oil_request(TEXT,UUID),
  public.fleet_oil_commit(BIGINT,UUID,TEXT,TEXT,JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fleet_oil_event_json(public.fleet_oil_events),
  public.fleet_oil_snapshot(),public.fleet_oil_request(TEXT,UUID),
  public.fleet_oil_commit(BIGINT,UUID,TEXT,TEXT,JSONB) TO service_role;

-- Only default policy/metadata initialization above. No real vehicle/event imports.
-- No grants on existing tables, repair changes, or client access policies.
COMMIT;
