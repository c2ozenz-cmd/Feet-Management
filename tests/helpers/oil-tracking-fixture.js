const {createMockData}=require('../../functions/lib/oil-tracking-mock-data');
const fixture=(asOf='2026-11-06')=>createMockData(asOf);
module.exports={fixture};
