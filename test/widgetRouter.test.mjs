import { widgetRegions, mergeWidgetRegions } from '../src/extraction/forensics/widgetRouter.js';
import assert from 'assert';
const vp = { convertToViewportPoint: (x,y)=>[x, 792-y], width:612, height:792 };
const W = (o)=>({subtype:'Widget', rect:[10,700,110,720], fieldType:'Tx', fieldName:'a', ...o});

// no widgets -> not a form
assert.equal(widgetRegions([], vp).hasAcroForm, false);
assert.equal(widgetRegions([{subtype:'Link'}], vp).hasAcroForm, false);

// types
const r = widgetRegions([
  W({fieldType:'Tx'}), W({fieldType:'Ch'}), W({fieldType:'Sig'}),
  W({fieldType:'Btn', checkBox:true}), W({fieldType:'Btn', radioButton:true}),
  W({fieldType:'Btn'}),                       // pushbutton -> dropped
], vp);
assert.equal(r.fields, 5, 'pushbutton must be dropped');
const labs = r.regions.map(x=>x.label+':'+x.subtype).join(',');
assert.ok(labs.includes('field:text') && labs.includes('field:choice')
  && labs.includes('signature:null') && labs.includes('checkbox:check')
  && labs.includes('checkbox:radio'), labs);

// hidden and degenerate dropped
assert.equal(widgetRegions([W({hidden:true})], vp).fields, 0);
assert.equal(widgetRegions([W({rect:[10,700,10.2,700.2]})], vp).fields, 0);

// y-flip: pdf y=700..720 on a 792 page -> viewport y=72..92
const b = widgetRegions([W({})], vp).regions[0].bbox;
assert.ok(Math.abs(b.y-72)<1e-6 && Math.abs(b.h-20)<1e-6, JSON.stringify(b));

// provenance is always established
assert.ok(widgetRegions([W({})], vp).regions.every(x=>x.provenance==='established'));

// merge: duplicate detector box dropped, non-duplicate KEPT
const w = widgetRegions([W({})], vp);
const dup = {label:'text', bbox:{x:10,y:72,w:100,h:20}};
const other = {label:'table', bbox:{x:300,y:400,w:100,h:50}};
const m = mergeWidgetRegions([dup, other], w);
assert.equal(m.replaced, 1, 'duplicate must be replaced');
assert.ok(m.regions.some(x=>x.label==='table'), 'non-duplicate must survive');
assert.equal(m.regions[0].label, 'form', 'form parent first');

// no acroform -> detector untouched
const m2 = mergeWidgetRegions([other], widgetRegions([], vp));
assert.equal(m2.regions.length, 1);
assert.equal(m2.replaced, 0);

console.log('widgetRouter: all assertions passed');
