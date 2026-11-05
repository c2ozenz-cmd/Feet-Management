"""Optimize only oversized, small-on-page logo images; preserve PDF text and signatures."""
import io
import hashlib
import json
import sys
from pathlib import Path
import pymupdf as fitz
from PIL import Image, ImageChops, ImageStat


def optimize(source, destination):
    doc = fitz.open(source)
    if doc.is_encrypted or doc.get_sigflags() > 0:
        doc.close()
        return {"status": "skipped_signed_or_encrypted"}
    texts = [page.get_text() for page in doc]
    image_counts = [len(page.get_images()) for page in doc]
    page_sizes = [(page.rect.width, page.rect.height) for page in doc]
    contents = [(page.xref, doc.xref_get_key(page.xref, "Contents")[1]) for page in doc]
    resource_objects = {}
    inline_resources = []
    original_streams = {xref: doc.xref_stream(xref) for page in doc for xref in page.get_contents()}
    for page in doc:
        kind, value = doc.xref_get_key(page.xref, "Resources")
        if kind == "xref":
            xref = int(value.split()[0])
            resource_objects[xref] = doc.xref_object(xref)
        elif kind == "dict":
            inline_resources.append((page.xref, value))
    seen = set()
    replaced = 0
    for page in doc:
        for image in page.get_images(full=True):
            xref, smask, width, height = image[:4]
            if xref in seen:
                continue
            seen.add(xref)
            if max(width, height) < 1000 or not 0.85 < width / height < 1.15:
                continue
            rectangles = page.get_image_rects(xref)
            if not rectangles or any(max(rect.width, rect.height) > 160 for rect in rectangles):
                continue
            pix = fitz.Pixmap(doc, xref)
            if smask:
                pix = fitz.Pixmap(pix, fitz.Pixmap(doc, smask))
            if pix.colorspace.n != 3:
                pix = fitz.Pixmap(fitz.csRGB, pix)
            raster = Image.frombytes("RGBA" if pix.alpha else "RGB", (pix.width, pix.height), pix.samples)
            raster.thumbnail((512, 512), Image.Resampling.LANCZOS)
            output = io.BytesIO()
            raster.save(output, format="PNG", optimize=True, compress_level=9)
            page.replace_image(xref, stream=output.getvalue())
            replaced += 1
    if not replaced:
        doc.close()
        return {"status": "no_large_logo"}
    # replace_image adds a temporary image resource. Restore the original page resources
    # and drawing commands so that only the original image xref is retained.
    for xref, value in resource_objects.items():
        doc.update_object(xref, value)
    for xref, value in inline_resources:
        doc.xref_set_key(xref, "Resources", value)
    for xref, value in contents:
        doc.xref_set_key(xref, "Contents", value)
    for xref, value in original_streams.items():
        doc.update_stream(xref, value)
    doc.save(destination, garbage=4, deflate=True, no_new_id=True, encryption=fitz.PDF_ENCRYPT_KEEP)
    doc.close()
    old = fitz.open(source)
    new = fitz.open(destination)
    if new.page_count != len(texts) or [page.get_text() for page in new] != texts:
        raise ValueError("Page count or text changed")
    if [(page.rect.width, page.rect.height) for page in new] != page_sizes:
        raise ValueError("Page dimensions changed")
    if [len(page.get_images()) for page in new] != image_counts:
        raise ValueError("Image count changed")
    # Verify rendered output, including the signature area, rather than only checking file size.
    differences = []
    for old_page, new_page in zip(old, new):
        before = old_page.get_pixmap(dpi=100, alpha=False)
        after = new_page.get_pixmap(dpi=100, alpha=False)
        a = Image.frombytes("RGB", (before.width, before.height), before.samples)
        b = Image.frombytes("RGB", (after.width, after.height), after.samples)
        difference = sum(ImageStat.Stat(ImageChops.difference(a, b)).mean) / 3
        if difference > 1.5:
            raise ValueError(f"Visual difference too high: {difference}")
        # Bottom half must be pixel-identical: totals, notes, stamps and handwritten signatures.
        region = (0, a.height // 2, a.width, a.height)
        if ImageChops.difference(a.crop(region), b.crop(region)).getbbox() is not None:
            raise ValueError("Bottom half changed")
        differences.append(round(difference, 5))
    old.close()
    new.close()
    return {"status": "verified", "replaced": replaced, "pages": len(texts), "visualDifference": differences,
            "beforeBytes": source.stat().st_size, "afterBytes": destination.stat().st_size,
            "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "optimizedSha256": hashlib.sha256(destination.read_bytes()).hexdigest()}


if __name__ == "__main__":
    root = Path(sys.argv[1]).resolve()
    destination = root / "optimized"
    destination.mkdir(exist_ok=True)
    previous_file = root / "compression-report.json"
    previous = json.loads(previous_file.read_text(encoding="utf-8")) if previous_file.exists() else {}
    report = {}
    for index, source in enumerate(sorted((root / "originals").glob("*.pdf"))):
        try:
            cached = previous.get(source.name, {})
            output_file = destination / source.name
            if cached.get("status") == "verified" and output_file.exists() and cached.get("sourceSha256") == hashlib.sha256(source.read_bytes()).hexdigest() and cached.get("optimizedSha256") == hashlib.sha256(output_file.read_bytes()).hexdigest():
                report[source.name] = cached
            else:
                report[source.name] = optimize(source, output_file)
        except Exception as error:
            report[source.name] = {"status": "error", "error": str(error)}
        if (index + 1) % 25 == 0:
            print(json.dumps({"processed": index + 1}), flush=True)
    (root / "compression-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"files": len(report), "statuses": {status: sum(r["status"] == status for r in report.values()) for status in sorted({r["status"] for r in report.values()})}}), flush=True)
