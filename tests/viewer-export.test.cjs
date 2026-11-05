// Run with: node --test tests/viewer-export.test.cjs
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'..','y16-y8-viewer.html'),'utf8');
function core(id,name){const script=html.match(new RegExp('<script id="'+id+'">([\\s\\S]*?)</script>'))[1];return vm.runInNewContext(script+'\n'+name,{Blob,TextEncoder,Uint8Array,Uint16Array,Uint32Array,DataView,ArrayBuffer});}
const RawCore=core('pixel-core','RawCore'),VideoCore=core('video-core','VideoCore');
function frames(first,last,pixels,format,header=0){
  const size=pixels*(format==='u8'?1:2),buffer=Buffer.alloc(header+(last-first+1)*size,0xa5);
  for(let n=first;n<=last;n++)for(let i=0;i<pixels;i++){
    const offset=header+(n-first)*size+i*(format==='u8'?1:2),value=(n*19+i)%(format==='u8'?256:65536);
    if(format==='u8')buffer[offset]=value;else if(format==='u16le')buffer.writeUInt16LE(value,offset);else buffer.writeUInt16BE(value,offset);
  }
  return buffer;
}
for(const format of ['u8','u16le','u16be'])test('20–80 includes 61 frames; preserves bytes and headers across files: '+format,async()=>{
  const pixels=12,header=7,first=frames(1,50,pixels,format,header),second=frames(51,100,pixels,format,header);
  const plan=RawCore.plan([new File([first],'part1.raw'),new File([second],'part2.raw')],pixels,format,header);
  const range=RawCore.frameRange(plan,20,80);
  assert.equal(range.count,61);assert.equal(range.bytes,61*pixels*(format==='u8'?1:2));
  const output=new Blob(RawCore.clipParts(plan,20,80));
  assert.deepEqual(Buffer.from(await output.arrayBuffer()),frames(20,80,pixels,format));
  const single=new Blob(RawCore.clipParts(plan,50,50));
  assert.deepEqual(Buffer.from(await single.arrayBuffer()),frames(50,50,pixels,format));
  const full=new Blob(RawCore.clipParts(plan,1,100));
  assert.deepEqual(Buffer.from(await full.arrayBuffer()),frames(1,100,pixels,format));
});
test('invalid frame ranges are rejected before slicing',()=>{
  const plan={total:100,frameBytes:24};
  for(const [start,end]of [[0,20],[20,101],[80,20],[1.5,20],[1,NaN],[1,Infinity]])assert.throws(()=>RawCore.frameRange(plan,start,end));
  assert.throws(()=>RawCore.frameRange(null,1,1));
});
test('per-file tails are omitted from exported RAW',async()=>{
  const a=frames(1,3,4,'u16be'),b=frames(4,6,4,'u16be');
  const plan=RawCore.plan([new File([a,Buffer.from([0xff])],'a.raw'),new File([b,Buffer.from([0xee,0xee])],'b.raw')],4,'u16be');
  const output=new Blob(RawCore.clipParts(plan,2,5));
  assert.deepEqual(Buffer.from(await output.arrayBuffer()),frames(2,5,4,'u16be'));
});
function elements(bytes,from=0,to=bytes.length){
  const result=[];let offset=from;
  while(offset<to){
    const start=offset;let idLength=1;while(!(bytes[offset]&(1<<(8-idLength))))idLength++;
    const id=bytes.readUIntBE(offset,idLength);offset+=idLength;
    let sizeLength=1;while(!(bytes[offset]&(1<<(8-sizeLength))))sizeLength++;
    let size=bytes[offset]&((1<<(8-sizeLength))-1);for(let i=1;i<sizeLength;i++)size=size*256+bytes[offset+i];
    offset+=sizeLength;const end=offset+size;assert(end<=to,'EBML element extends past parent');
    result.push({id,start,data:offset,end,size});offset=end;
  }
  assert.equal(offset,to);return result;
}
const unsigned=(bytes,e)=>Number(BigInt('0x'+bytes.subarray(e.data,e.end).toString('hex')));
for(const fps of [5,10,20,50])test('WebM duration, exact frame timestamps, keyframe cues and seek positions at '+fps+' fps',async()=>{
  const count=61,frames=Array.from({length:count},(_,i)=>({timestamp:Math.round(i*1e6/fps),key:i%(fps*2)===0,data:new Uint8Array(131+i%3).fill(i)}));
  const output=VideoCore.webm(frames,384,288,fps),bytes=Buffer.from(await output.arrayBuffer());
  assert.equal(output.type,'video/webm');
  const top=elements(bytes);assert.equal(top[0].id,0x1a45dfa3);assert.equal(top[1].id,0x18538067);
  const segment=top[1],children=elements(bytes,segment.data,segment.end);
  const find=id=>children.find(e=>e.id===id),info=find(0x1549a966),tracks=find(0x1654ae6b),cues=find(0x1c53bb6b);
  const duration=elements(bytes,info.data,info.end).find(e=>e.id===0x4489);
  assert.equal(bytes.readDoubleBE(duration.data),count*1000/fps);
  const entry=elements(bytes,tracks.data,tracks.end)[0],track=elements(bytes,entry.data,entry.end);
  const codec=track.find(e=>e.id===0x86);assert.equal(bytes.subarray(codec.data,codec.end).toString(),'V_VP8');
  const video=track.find(e=>e.id===0xe0),dimensions=elements(bytes,video.data,video.end);
  assert.equal(unsigned(bytes,dimensions.find(e=>e.id===0xb0)),384);assert.equal(unsigned(bytes,dimensions.find(e=>e.id===0xba)),288);
  const clusters=children.filter(e=>e.id===0x1f43b675),timestamps=[];
  for(const cluster of clusters){
    const contents=elements(bytes,cluster.data,cluster.end),base=unsigned(bytes,contents.find(e=>e.id===0xe7));
    const blocks=contents.filter(e=>e.id===0xa3);assert(bytes[blocks[0].data+3]&0x80);
    for(const block of blocks)timestamps.push(base+bytes.readInt16BE(block.data+1));
  }
  assert.deepEqual(timestamps,frames.map(f=>Math.round(f.timestamp/1000)));
  const cuePoints=elements(bytes,cues.data,cues.end);assert.equal(cuePoints.length,clusters.length);
  cuePoints.forEach((point,i)=>{
    const fields=elements(bytes,point.data,point.end),positions=fields.find(e=>e.id===0xb7),position=elements(bytes,positions.data,positions.end).find(e=>e.id===0xf1);
    assert.equal(unsigned(bytes,position),clusters[i].start-segment.data);
  });
  const seekHead=find(0x114d9b74);
  for(const seek of elements(bytes,seekHead.data,seekHead.end)){
    const fields=elements(bytes,seek.data,seek.end),id=unsigned(bytes,fields.find(e=>e.id===0x53ab)),position=unsigned(bytes,fields.find(e=>e.id===0x53ac));
    assert.equal(position,find(id).start-segment.data);
  }
});
