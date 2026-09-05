import assert from 'assert';
import { arbitrate, EVIDENCE_RANK } from '../src/extraction/forensics/regionArbiter.js';
const B=(x,y,w,h)=>({x,y,w,h});
const C=(label,bbox,source,confidence)=>({label,bbox,source,confidence});

// 1. A TABLE INSIDE A FORM IS BOTH. Neither overrides the other.
{
  const {regions}=arbitrate([
    C('form',  B(0,0,600,800),'widget',1.0),
    C('table', B(50,200,500,200),'lattice',0.9),
    C('field', B(60,220,100,20),'widget',1.0),
  ]);
  assert.equal(regions.length,3,'all three survive; containment is not conflict');
  const f=regions.find(r=>r.label==='field');
  assert.equal(f.parentLabel,'table','field takes the SMALLEST container, not the form');
  const t=regions.find(r=>r.label==='table');
  assert.equal(t.parentLabel,'form','table nests inside the form');
}

// 2. EVIDENCE OUTRANKS CONFIDENCE. A widget rect beats a confident detector box.
{
  const {regions,dropped}=arbitrate([
    C('text',  B(100,100,200,30),'detector',0.94),
    C('field', B(100,100,200,30),'widget',0.31),
  ]);
  assert.equal(regions.length,1);
  assert.equal(regions[0].source,'widget','the FILE wins over a 0.94 guess');
  assert.equal(regions[0].label,'field');
  assert.ok(/already claimed by widget/.test(dropped[0].reason));
}

// 3. Same evidence type -> confidence arbitrates.
{
  const {regions}=arbitrate([
    C('text',   B(10,10,200,40),'detector',0.40),
    C('heading',B(10,10,200,40),'detector',0.85),
  ]);
  assert.equal(regions.length,1);
  assert.equal(regions[0].label,'heading','higher confidence wins at equal rank');
}

// 4. ...but only if CLEARLY beaten; a near-tie keeps the incumbent stable.
{
  const {regions}=arbitrate([
    C('text',   B(10,10,200,40),'detector',0.80),
    C('heading',B(10,10,200,40),'detector',0.82),
  ]);
  assert.equal(regions[0].label,'text','a 0.02 edge must not flip the result');
}

// 5. Resolution rides inside confidence, not as a separate axis.
{
  const weak=arbitrate([C('table',B(0,0,300,300),'geometry',0.30),
                        C('table',B(0,0,300,300),'geometry',0.90)]);
  assert.equal(weak.regions[0].confidence,0.90,'the better-resolved claimant wins at equal rank');
}

// 6. Disjoint regions never conflict.
{
  const {regions}=arbitrate([
    C('table',B(0,0,100,100),'lattice',0.9),
    C('table',B(300,300,100,100),'lattice',0.9),
  ]);
  assert.equal(regions.length,2);
  assert.ok(regions.every(r=>r.parent===null));
}

// 7. Rank ordering is the documented one.
assert.ok(EVIDENCE_RANK.widget < EVIDENCE_RANK.lattice);
assert.ok(EVIDENCE_RANK.lattice < EVIDENCE_RANK.geometry);
assert.ok(EVIDENCE_RANK.geometry < EVIDENCE_RANK.detector);

console.log('regionArbiter: all assertions passed');
