import assert from 'assert';
import { containment, latticeCells, assignCellsToTable, buildContainment, attachCaptions }
  from '../src/extraction/forensics/relations.js';
const B=(x,y,w,h)=>({x,y,w,h});

// containment is asymmetric and normalised by the INNER box
assert.equal(containment(B(10,10,10,10), B(0,0,100,100)), 1);
assert.equal(containment(B(0,0,100,100), B(10,10,10,10)), 0.01);
assert.equal(containment(B(200,200,10,10), B(0,0,100,100)), 0);

// lattice -> cell rects
const lat={rows:[0,10,20], cols:[0,10,20,30]};
const cells=latticeCells(lat);
assert.equal(cells.length, 6, '2 rows x 3 cols');
assert.deepEqual(cells[0].bbox, B(0,0,10,10));
assert.deepEqual(cells[5].bbox, B(20,10,10,10));

// THE FIX: an item far outside the grid must be ORPHANED, not filed into the
// least-far cell. buildTable's nearest-centroid search is unbounded and does
// exactly that.
const r1=assignCellsToTable(lat, [{point:{x:5,y:5}}, {point:{x:500,y:500}}]);
assert.equal(r1.assigned, 1, 'the in-grid item is assigned');
assert.equal(r1.orphaned, 1, 'the far item must be reported, not absorbed');

// an item just outside a cell but within tolerance still lands
const r2=assignCellsToTable(lat, [{point:{x:10.5,y:5}}]);
assert.equal(r2.assigned, 1);

// containment: child takes the SMALLEST containing parent
const regs=[
  {label:'form',  bbox:B(0,0,100,100)},   // 0 outer
  {label:'table', bbox:B(10,10,50,50)},   // 1 middle
  {label:'field', bbox:B(20,20,10,10)},   // 2 inner
];
const par=buildContainment(regs);
assert.equal(par[2], 1, 'field attaches to table, not the enclosing form');
assert.equal(par[1], 0, 'table attaches to form');
assert.equal(par[0], -1, 'outermost has no parent');
// no cycles, no self-parenting
assert.ok(par.every((p,i)=>p!==i));

// caption attaches to the figure it shares a column with, not a far one
const cregs=[
  {label:'picture', bbox:B(0,0,100,60)},
  {label:'caption', bbox:B(0,62,100,10)},
  {label:'picture', bbox:B(300,0,100,60)},
];
const rel=attachCaptions(cregs);
assert.equal(rel.length, 1);
assert.equal(rel[0].to, cregs[0], 'must pick the vertically adjacent, column-sharing figure');
assert.equal(rel[0].provenance, 'inferred', 'geometric attachment is never `established`');

// a caption with no column overlap attaches to nothing
assert.equal(attachCaptions([
  {label:'caption', bbox:B(0,0,50,10)},
  {label:'picture', bbox:B(300,0,50,50)},
]).length, 0);

console.log('relations: all assertions passed');
