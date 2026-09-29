// A tiny fake PLM system, used to demo and test the PLM integration end-to-end.
// It behaves like a real one in the ways that matter: token auth, part numbers, revisions,
// lifecycle states, a BOM, and file downloads from URLs that have no file extension.
//
//   GET /mock-plm/api/parts?search=        -> { items: [...] }
//   GET /mock-plm/api/parts/:number        -> part
//   GET /mock-plm/api/parts/:number/bom    -> { items: [{ number, title, cadName, state, ... }] }
//   GET /mock-plm/api/parts/:number/content -> CAD file (Content-Disposition carries the name)
import fs from 'node:fs'
import path from 'node:path'

export function createMockPlm({ samplesDir, token }) {
  const f = (rel) => path.join(samplesDir, rel)
  const parts = [
    { number: 'CAR-0001', title: 'Sample car - full assembly', revision: 'C', state: 'Released', owner: 'j.meyer', file: 'sample_car.step' },
    { number: 'ENG-1001', title: 'Engine block', revision: 'B', state: 'In Work', owner: 'a.khan', file: 'car_parts/engine_block.step' },
    { number: 'INT-2001', title: 'Driver seat', revision: 'A', state: 'Released', owner: 's.lee', file: 'car_parts/seat.step' },
    { number: 'INT-2002', title: 'Steering wheel', revision: 'A', state: 'In Review', owner: 's.lee', file: 'car_parts/steering_wheel.step' },
    { number: 'WHL-3001', title: 'Wheel rim 16"', revision: 'D', state: 'Released', owner: 'p.rossi', file: 'car_parts/wheel_rim.step' },
    { number: 'SCN-9001', title: 'Car body scan (mesh)', revision: 'A', state: 'Obsolete', owner: 'lab', file: 'sample_car.stl' },
  ]
    .filter((p) => fs.existsSync(f(p.file)))
    .map((p) => ({ ...p, cadFile: { name: path.basename(p.file), size: fs.statSync(f(p.file)).size } }))

  // BOM of the car: each line links a PLM item to a CAD product name inside the STEP file.
  const groups = [
    ['Body', 'BDY', 'Released'], ['Glass', 'GLS', 'Released'], ['Interior', 'INT', 'In Work'], ['Engine', 'ENG', 'In Review'],
    ['Gearbox', 'ENG', 'In Review'], ['Axle', 'CHS', 'Released'], ['Wheel', 'WHL', 'Released'], ['Light', 'LGT', 'In Work'],
    ['Bumper', 'BDY', 'Released'], ['Mirror', 'BDY', 'Obsolete'],
  ]
  const cadNames = [
    'Body_Lower', 'Body_Hood', 'Body_TrunkLid', 'Body_Cabin', 'Glass_Windscreen', 'Glass_RearScreen', 'Glass_Side_Left', 'Glass_Side_Right',
    'Interior_Floor', 'Interior_Dashboard', 'Interior_Seat_Driver', 'Interior_Seat_Passenger', 'Interior_Seat_Rear_Left', 'Interior_Seat_Rear_Right',
    'Interior_SteeringWheel', 'Engine_Block', 'Engine_CylinderHead', 'Engine_Radiator', 'Gearbox', 'Axle_Front', 'Axle_Rear',
    'Wheel_Front_Left_Tyre', 'Wheel_Front_Left_Rim', 'Light_Head_Left', 'Light_Head_Right', 'Light_Tail_Left', 'Light_Tail_Right',
    'Bumper_Front', 'Bumper_Rear', 'Mirror_Left', 'Mirror_Right',
  ]
  const counters = {}
  const bom = cadNames.map((cadName) => {
    const [, prefix, state] = groups.find(([g]) => cadName.startsWith(g))
    counters[prefix] = (counters[prefix] ?? 100) + 1
    return { number: `${prefix}-${counters[prefix]}`, title: cadName.replace(/_/g, ' '), cadName, revision: 'A', state, quantity: 1 }
  })

  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  return function handle(req, res, url) {
    if (!url.pathname.startsWith('/mock-plm/api/')) return false
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'Missing or invalid PLM token' }), true
    const rest = url.pathname.slice('/mock-plm/api/'.length).split('/').map(decodeURIComponent)
    if (rest[0] !== 'parts') return json(res, 404, { error: 'Not found' }), true
    if (rest.length === 1) {
      const q = (url.searchParams.get('search') ?? '').toLowerCase()
      const items = parts.filter((p) => !q || [p.number, p.title, p.state, p.cadFile.name].some((s) => s.toLowerCase().includes(q)))
      return json(res, 200, { items: items.map(({ file, ...p }) => p) }), true
    }
    const part = parts.find((p) => p.number === rest[1])
    if (!part) return json(res, 404, { error: 'Part not found' }), true
    if (rest.length === 2) {
      const { file, ...p } = part
      return json(res, 200, p), true
    }
    if (rest[2] === 'bom') return json(res, 200, { items: part.number === 'CAR-0001' ? bom : [] }), true
    if (rest[2] === 'content') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': part.cadFile.size,
        'Content-Disposition': `attachment; filename="${part.cadFile.name}"`,
      })
      fs.createReadStream(f(part.file)).pipe(res)
      return true
    }
    return json(res, 404, { error: 'Not found' }), true
  }
}
