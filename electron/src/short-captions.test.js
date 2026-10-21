const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { captionAss, validateCaptions } = require('./short-captions');
const style = {color:'#ffffff',highlight:'#ffe600',shadow:'#000000',outline:'#000000',outlineWidth:3,font:'Arial',fontSize:64,highlightScale:1.2};
const captions = {enabled:true,style,words:[{start:10,end:10.3,text:'Olá'},{start:10.4,end:11,text:'mundo'}]};
test('caption settings survive normalization and reject invalid timing/style', () => {
  const {settings} = require('./short-editor');
  assert.deepEqual(settings({captions}).captions,captions);
  assert.throws(() => validateCaptions({...captions,style:{...style,color:'red'}}));
  assert.throws(() => validateCaptions({...captions,words:[{start:1,end:0,text:'x'}]}));
});
test('ASS maps source words to cuts and highlights only the current word', () => {
  const ass=captionAss({settings:{captions,transition:'cut'},ranges:[{start:10,end:12}]});
  const lines=ass.split('\n').filter(l=>l.startsWith('Dialogue:'));
  assert.equal(lines.length,3);
  assert.match(lines[0],/0:00:00.00,0:00:00.30/);
  assert.match(lines[1],/0:00:00.30,0:00:00.40/);
  assert.match(lines[2],/0:00:00.40,0:00:01.00/);
  assert.equal(lines[0].split('fscx120').length,2);
  assert.equal(lines[1].includes('fscx120'),false);
  assert.ok(lines[0].includes('}Olá{')); assert.ok(lines[2].includes('}mundo{'));
});
test('disabled captions leave export unchanged; enabled empty captions cannot silently export', () => {
  assert.equal(captionAss({settings:{},ranges:[]}), '');
  assert.throws(()=>captionAss({settings:{captions:{...captions,words:[]}},ranges:[]}));
});
test('browser timing never highlights in a pause or at an exclusive end boundary',()=>{
 const ts=require('../../web/node_modules/typescript');const fs=require('fs');const vm=require('vm');
 const source=fs.readFileSync(require('path').join(__dirname,'../../web/src/app/ferramentas/shorts-generator/short-captions.ts'),'utf8');
 const exports={};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports});
 assert.equal(exports.captionAt(captions.words,10.1).filter(w=>w.active).length,1);
 assert.equal(exports.captionAt(captions.words,10.3).length,2);
 assert.equal(exports.captionAt(captions.words,10.3).filter(w=>w.active).length,0);
 assert.equal(exports.captionAt(captions.words,10.4).find(w=>w.active).text,'mundo');
 assert.equal(exports.captionAt(captions.words,11).length,0);
 const aligned=exports.alignedCaptionWords([{start:0,end:1,text:'a'},{start:.5,end:2,text:'b'}]);
 assert.equal(aligned[0].end,.5);
 assert.equal(exports.captionAt(aligned,.6).filter(w=>w.active).length,1);
 exports.validateCaptions(captions);
 assert.throws(()=>exports.validateCaptions({...captions,style:{...style,fontSize:NaN}}));
});

test('transition overlaps never display captions from two cuts at once',()=>{
 const words=[{start:0,end:1,text:'primeiro'},{start:2,end:3,text:'segundo'}];
 const ass=captionAss({settings:{captions:{...captions,words},transition:'fade',transitionSeconds:.5},ranges:[{start:0,end:1},{start:2,end:3}]});
 const lines=ass.split('\n').filter(l=>l.startsWith('Dialogue:'));
 assert.equal(lines.length,2);
 assert.match(lines[0],/0:00:00.00,0:00:00.75/);
 assert.match(lines[1],/0:00:00.75,0:00:01.50/);
});

test('line spacing and height reach both exporters, with defaults for older projects',()=>{
 const ts=require('../../web/node_modules/typescript');const vm=require('vm');
 const source=fs.readFileSync(require('path').join(__dirname,'../../web/src/app/ferramentas/shorts-generator/short-captions.ts'),'utf8');
 const exports={};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports});
 const words=['um','dois','três','quatro','cinco','seis'].map((text,i)=>({text,start:i,end:i+.9}));
 const custom={enabled:true,words,style:{...style,lineHeight:2,positionY:50}};
 const positions=[];
 const ctx={save(){},restore(){},measureText(text){return {width:text.length*30}},strokeText(){},fillText(text,x,y){positions.push(y)}};
 exports.drawCaptions(ctx,custom,.1,1080,1920);
 assert.equal(positions.length,6);
 assert.equal(positions[0],896); assert.equal(positions[3],1024);
 const ass=captionAss({settings:{captions:custom,transition:'cut'},ranges:[{start:0,end:6}]});
 assert.ok(ass.includes('pos(540,896)')); assert.ok(ass.includes('pos(540,1024)'));
 const legacy=captionAss({settings:{captions,transition:'cut'},ranges:[{start:10,end:12}]});
 assert.ok(legacy.includes('pos(540,1344)'));
 for(const invalid of [{lineHeight:0},{lineHeight:NaN},{positionY:101},{positionY:Infinity}]) {
  assert.throws(()=>validateCaptions({...custom,style:{...custom.style,...invalid}}));
  assert.throws(()=>exports.validateCaptions({...custom,style:{...custom.style,...invalid}}));
 }
});

function browserCaptions() {
 const ts=require('../../web/node_modules/typescript'), vm=require('vm'), path=require('path');
 const exports={};
 const source=fs.readFileSync(path.join(__dirname,'../../web/src/app/ferramentas/shorts-generator/short-captions.ts'),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports});
 return exports;
}
test('requested default and conservative duplicate removal preserve actual repeated speech',()=>{
 const api=browserCaptions(), defaults=api.captionStyle();
 assert.equal(defaults.font,'Verdana'); assert.equal(defaults.fontSize,99);
 assert.equal(defaults.outlineWidth,2); assert.equal(defaults.highlightScale,1.2);
 const words=api.alignedCaptionWords([{start:0,end:.4,text:'não'},{start:.02,end:.42,text:'não'},{start:.5,end:.9,text:'não'}]);
 assert.equal(words.length,2); assert.equal(words[0].end,.42); assert.equal(words[1].start,.5);
 const spaced=api.alignedCaptionWords([{start:1,end:1.2,text:'sim'},{start:2,end:2.2,text:'sim'}]);
 assert.equal(spaced.length,2);
});
test('phrases stay stable between words, change once, disappear at silence, and obey cuts',()=>{
 const api=browserCaptions();
 const words=['Uma','frase','com','seis','palavras','aqui','Outra','frase.'].map((text,i)=>({text,start:i*.4,end:i*.4+.3}));
 const seen=[];
 for(let t=.01;t<2.31;t+=.05){
   const frame=api.captionAt(words,t);
   assert.ok(frame.filter(w=>w.active).length<=1);
   seen.push(frame.map(w=>w.text).join(' '));
 }
 assert.equal(new Set(seen).size,1);
 assert.equal(api.captionAt(words,2.35).length,0);
 assert.equal(api.captionAt(words,2.45)[0].text,'Outra');
 const clipped=api.captionWordsInRange(words,{start:.8,end:1.5});
 assert.equal(api.captionAt(clipped,.9).map(w=>w.text).join(' '),'com seis');
 assert.equal(api.captionAt(clipped,1.5).length,0);
});
test('ASS output matches browser phrases and has a single active word at every sampled time',()=>{
 const api=browserCaptions();
 const words=['Uma','frase','com','seis','palavras','aqui','Outra','frase.'].map((text,i)=>({text,start:i*.4,end:i*.4+.3}));
 const ass=captionAss({settings:{captions:{enabled:true,style,words},transition:'cut'},ranges:[{start:0,end:4}]});
 const seconds=t=>{const [h,m,s]=t.split(':').map(Number);return h*3600+m*60+s};
 const events=ass.split('\n').filter(l=>l.startsWith('Dialogue:')).map(line=>{
   const fields=line.split(',');return {start:seconds(fields[1]),end:seconds(fields[2]),text:fields.slice(9).join(',')};
 });
 for(let t=.015;t<4;t+=.03){
   const active=events.filter(e=>e.start<=t && t<e.end);
   const text=active.map(e=>e.text.replace(/\{[^}]*\}/g,'')).join(' ');
   const expected=api.captionAt(words,t);
   assert.equal(text,expected.map(w=>w.text).join(' '),'time '+t);
   assert.equal(active.filter(e=>e.text.includes('fscx120')).length,expected.filter(w=>w.active).length);
 }
});
test('browser transition uses both cuts during the overlap instead of dropping the incoming beginning',()=>{
 const ts=require('../../web/node_modules/typescript'), vm=require('vm'), path=require('path');
 const exports={};const source=fs.readFileSync(path.join(__dirname,'../../web/src/app/ferramentas/shorts-generator/short-browser-editor.ts'),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,require:id=>id==='./short-captions'?browserCaptions():{}});
 const {segments,duration}=exports.timeline({ranges:[{start:0,end:1},{start:2,end:3}],settings:{transition:'fade',transitionSeconds:.5}});
 assert.equal(duration,1.5);
 const frame=exports.keyframeAt(segments,.75);
 assert.equal(frame.current.cut.start,2); assert.equal(frame.previous.cut.start,0); assert.equal(frame.fraction,.5);
 assert.equal(exports.keyframeAt(segments,1.1).previous,undefined);
});

test('character target changes phrase length without splitting words, and accepts fonts up to 200',()=>{
 const api=browserCaptions();
 const words=['uma','outra','frase','de','teste','com','mais','palavras','para','mostrar'].map((text,i)=>({text,start:i*.3,end:i*.3+.25}));
 const small={...api.captionStyle(),charsPerCaption:10}, large={...small,charsPerCaption:60};
 assert.ok(api.captionAt(words,.1,large).length>api.captionAt(words,.1,small).length);
 for(const config of [small,large,{...large,fontSize:200,lineHeight:2.5}]) {
  const groups=api.captionGroups(words,config);
  assert.equal(groups.flat().map(w=>w.text).join(' '),words.map(w=>w.text).join(' '));
  for(const group of groups){
   const lines=api.captionLines(group,config.fontSize), center=api.captionCenter(config,lines.length);
   const half=((lines.length-1)*config.fontSize*config.lineHeight+config.fontSize*config.highlightScale)/2;
   assert.ok(center-half>=96);assert.ok(center+half<=1824);
  }
  validateCaptions({enabled:true,style:config,words});api.validateCaptions({enabled:true,style:config,words});
 }
 const tooLarge={enabled:true,style:{...large,fontSize:201},words};
 assert.throws(()=>validateCaptions(tooLarge));assert.throws(()=>api.validateCaptions(tooLarge));
 assert.ok(api.captionLineScale([{text:'extraordinariamente'}],{...large,fontSize:200})<1);
 const assSmall=captionAss({settings:{captions:{enabled:true,style:small,words},transition:'cut'},ranges:[{start:0,end:3}]});
 const assLarge=captionAss({settings:{captions:{enabled:true,style:large,words},transition:'cut'},ranges:[{start:0,end:3}]});
 assert.notEqual(assSmall,assLarge);
 for(const charsPerCaption of [0,121,NaN,20.5]) {
  assert.throws(()=>validateCaptions({enabled:true,style:{...large,charsPerCaption},words}));
  assert.throws(()=>api.validateCaptions({enabled:true,style:{...large,charsPerCaption},words}));
 }
});

test('non-Impact fonts are always bold in both renderers, including saved normal styles',()=>{
 const api=browserCaptions(), defaults=api.captionStyle();
 assert.equal(defaults.bold,true);assert.equal(defaults.lineHeight,1);assert.equal(defaults.positionY,70);
 for(const preset of api.captionPresets){
  assert.equal(preset.style.lineHeight,1);assert.equal(preset.style.bold,preset.style.font !== 'Impact');assert.equal(preset.style.positionY,70);
  api.validateCaptions({...captions,style:preset.style});validateCaptions({...captions,style:preset.style});
 }
 for(const font of api.captionFonts) for(const bold of [undefined,false,true]) {
  const config={...style,font,bold}; const effectiveBold=font !== 'Impact' || bold;
  const fonts=[];const ctx={save(){},restore(){},measureText(text){fonts.push(this.font);return {width:text.length*30}},strokeText(){},fillText(){fonts.push(this.font)}};
  api.drawCaptions(ctx,{...captions,style:config},10.1,1080,1920);
  assert.ok(fonts.length>0 && fonts.every(font=>font.startsWith(effectiveBold?'bold ':'normal ')));
  const ass=captionAss({settings:{captions:{...captions,style:config},transition:'cut'},ranges:[{start:10,end:12}]});
  assert.equal(ass.split('\n').find(l=>l.startsWith('Style:')).split(',')[7],effectiveBold?'-1':'0');
  assert.equal(require('./short-editor').settings({captions:{...captions,style:config}}).captions.style.bold,bold);
 }
 assert.throws(()=>validateCaptions({...captions,style:{...style,bold:'yes'}}));
 assert.throws(()=>api.validateCaptions({...captions,style:{...style,bold:1}}));
});

test('all font choices are accepted and preserved by both caption renderers',()=>{
 const api=browserCaptions();assert.ok(api.captionFonts.includes('Comic Sans MS'));
 for(const font of api.captionFonts){
  const config={...captions,style:{...api.captionStyle(),font}};
  api.validateCaptions(config);assert.equal(validateCaptions(config).style.font,font);
  const ass=captionAss({settings:{captions:config,transition:'cut'},ranges:[{start:10,end:12}]});
  assert.equal(ass.split('\n').find(l=>l.startsWith('Style:')).split(',')[1],font);
 }
});
test('render action warns about missing analysis before opening an output picker or starting an export',async()=>{
 const ts=require('../../web/node_modules/typescript'),vm=require('vm'),path=require('path');
 const source=fs.readFileSync(path.join(__dirname,'../../web/src/app/ferramentas/shorts-generator/shorts-generator.component.ts'),'utf8');
 const tree=ts.createSourceFile('component.ts',source,ts.ScriptTarget.Latest,true);
 const component=tree.statements.find(s=>ts.isClassDeclaration(s)&&s.name.text==='ShortsGeneratorComponent');
 const method=component.members.find(m=>m.name?.getText(tree)==='render');
 const exports={};vm.runInNewContext(ts.transpileModule('export class Subject {'+method.getText(tree)+'}',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports});
 const render=exports.Subject.prototype.render;
 let picked=0,commands=0;
 const pending={...captions,words:[]};
 const state={captions:pending,captionWorking:false,captionRenderAlert:'',desktop:{shortCommand:true,chooseShortOutput:async()=>{picked++;return 'short.mp4'}},command:async()=>{commands++}};
 const short={id:'one',name:'Short',settings:{captions:{...captions,enabled:false}}};
 await render.call(state,short);assert.match(state.captionRenderAlert,/has not been analyzed/);assert.equal(picked,0);assert.equal(commands,0);
 state.captionWorking=true;await render.call(state,short);assert.match(state.captionRenderAlert,/still in progress/);assert.equal(picked,0);
 state.captionWorking=false;state.captions={...captions,enabled:false};short.settings.captions=pending;
 await render.call(state,short);assert.match(state.captionRenderAlert,/has not been analyzed/);assert.equal(commands,0);
 state.captions=captions;short.settings.captions=captions;await render.call(state,short);assert.equal(picked,1);assert.equal(commands,1);assert.equal(state.captionRenderAlert,'');
 state.desktop=undefined;state.captions=pending;short.settings.captions=pending;await render.call(state,short);assert.equal(commands,1);
 state.captions={...pending,enabled:false};short.settings.captions=state.captions;await render.call(state,short);assert.equal(commands,2);
});
