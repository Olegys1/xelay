/** Bounded structural media validation, not an antivirus or codec decoder.
 * No network, filesystem, subprocess, native decoder or metadata execution.
 * Primary format references:
 * https://www.rfc-editor.org/rfc/rfc3003
 * https://id3.org/id3v2.3.0 / https://id3.org/id3v2.4.0-structure
 * https://learn.microsoft.com/en-us/windows/win32/xaudio2/resource-interchange-file-format--riff-
 * https://learn.microsoft.com/en-us/windows/win32/api/mmeapi/ns-mmeapi-waveformatex
 * https://www.rfc-editor.org/rfc/rfc3533 / rfc7845 / rfc6716 / rfc8794
 * https://www.webmproject.org/docs/container/
 * https://developer.apple.com/documentation/quicktime-file-format/atoms
 * https://aomediacodec.github.io/av1-avif/
 */
const MAX=50*1024*1024,META=2*1024*1024,MAX_ENTRIES=1000000
export class MediaValidationError extends Error { readonly status=422;constructor(readonly code='UPLOAD_MEDIA_INVALID'){super(code);this.name='MediaValidationError'} }
const bad=(code='UPLOAD_MEDIA_INVALID'):never=>{throw new MediaValidationError(code)}
function check(ok:unknown,code='UPLOAD_MEDIA_INVALID'):asserts ok{if(!ok)bad(code)}
const profile=()=>bad('UPLOAD_MEDIA_PROFILE_UNSUPPORTED')
const zeros=(b:Buffer)=>b.every(v=>v===0)
const text=(b:Buffer)=>{check(b.length<=META);check(!/<!DOCTYPE|<!ENTITY|<script\b|<html\b|javascript:/i.test(b.toString('utf8').replace(/\x00/g,'')));return b}
const u64=(b:Buffer,p:number)=>{check(p>=0&&p+8<=b.length);const n=b.readBigUInt64BE(p);check(n<=BigInt(Number.MAX_SAFE_INTEGER));return Number(n)}
function synchsafe(b:Buffer,p:number){check(p+4<=b.length&&b.subarray(p,p+4).every(v=>v<128));return b[p]*2097152+b[p+1]*16384+b[p+2]*128+b[p+3]}
function unsync(b:Buffer){const out:number[]=[];for(let p=0;p<b.length;p++){out.push(b[p]);if(b[p]===255&&b[p+1]===0)p++}return Buffer.from(out)}
function id3(b:Buffer):number{
 if(b.toString('ascii',0,3)!=='ID3')return 0
 check(b.length>=10);const version=b[3],flags=b[5];check([2,3,4].includes(version)&&b[4]!==255)
 check(!(flags&(version===2?0x7f:version===3?0x1f:0x0f)));if(flags&0x20)profile()
 const size=synchsafe(b,6);check(size<=META&&10+size<=b.length)
 const end=10+size,footer=version===4&&!!(flags&0x10)
 if(footer){check(end+10<=b.length&&b.toString('ascii',end,end+3)==='3DI'&&b.subarray(end+3,end+10).equals(b.subarray(3,10)))}
 let body=b.subarray(10,end);if(flags&0x80)body=unsync(body)
 let p=0;if(flags&0x40){check(version!==2&&body.length>=4);const n=version===4?synchsafe(body,0):body.readUInt32BE(0)+4;check(n>=6&&n<=body.length);p=n}
 for(let count=0;p<body.length;count++){
  check(count<1024);if(body[p]===0){check(zeros(body.subarray(p)));break}
  const h=version===2?6:10;check(p+h<=body.length);const name=body.toString('ascii',p,p+(version===2?3:4));check(/^[A-Z0-9]{3,4}$/.test(name))
  const n=version===2?body.readUIntBE(p+3,3):version===4?synchsafe(body,p+4):body.readUInt32BE(p+4);check(n>0&&p+h+n<=body.length)
  let data=body.subarray(p+h,p+h+n)
  if(version!==2){const status=body[p+8],f=body[p+9];check(!(status&(version===4?0x8f:0x1f))&&!(f&(version===4?0xb0:0x1f)));if(f&(version===4?0x0c:0xc0))profile();if(f&(version===4?0x40:0x20)){check(data.length>1);data=data.subarray(1)}if(version===4&&f&2)data=unsync(data);if(version===4&&f&1){check(data.length>=4);synchsafe(data,0);data=data.subarray(4)}}
  if(name[0]==='T'||['COMM','USLT','COM','ULT'].includes(name)){check(data.length>0&&data[0]<=3);text(data)}
  else if(['APIC','PIC'].includes(name)){
   check(data.length>5&&data[0]<=3);let q=1,mime='';if(name==='PIC'){mime=data.toString('ascii',1,4);q=4}else{const at=data.indexOf(0,q);check(at>q&&at-q<40);mime=data.toString('ascii',q,at);q=at+1}check(q<data.length);q++
   if(data[0]===1||data[0]===2){while(q+1<data.length&&(data[q]!==0||data[q+1]!==0))q+=2;q+=2}else{const at=data.indexOf(0,q);check(at>=q);q=at+1}check(q<data.length)
   const image=data.subarray(q);if(['image/jpeg','JPG'].includes(mime))check(image.length>=4&&image.readUInt16BE(0)===0xffd8&&image.readUInt16BE(image.length-2)===0xffd9)
   else if(['image/png','PNG'].includes(mime))check(image.length>=45&&image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&image.toString('ascii',image.length-8,image.length-4)==='IEND')
   else profile()
  }else if(!['PCNT','POPM','CNT','POP'].includes(name))profile()
  p+=h+n
 }
 return end+(footer?10:0)
}
function mp3(b:Buffer){
 let p=id3(b),end=b.length;if(end-p>=128&&b.toString('ascii',end-128,end-125)==='TAG'){text(b.subarray(end-125,end-1));end-=128}
 let frames=0,identity=''
 while(p<end){check(++frames<=MAX_ENTRIES&&p+4<=end);const h=b.readUInt32BE(p),v=(h>>>19)&3,layer=(h>>>17)&3,rate=(h>>>10)&3,index=(h>>>12)&15,padding=(h>>>9)&1
  check((h>>>21)===0x7ff&&v!==1&&layer===1&&rate!==3&&index>0&&index<15&&(h&3)!==2)
  const hz=[44100,48000,32000][rate]/(v===3?1:v===2?2:4),kb=(v===3?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[index]
  const length=Math.floor((v===3?144000:72000)*kb/hz)+padding,mono=((h>>>6)&3)===3,side=v===3?(mono?17:32):(mono?9:17),crc=(h>>>16)&1?0:2
  check(length>=4+crc+side&&p+length<=end);const signature=`${v}:${hz}:${mono}`;if(identity)check(identity===signature);identity=signature;p+=length
 }
 check(frames>=2&&p===end)
}
function wave(b:Buffer){
 check(b.length>=44&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WAVE'&&b.readUInt32LE(4)+8===b.length)
 let p=12,fmt:Buffer|undefined,data:Buffer|undefined,fact:Buffer|undefined
 for(let n=0;p<b.length;n++){check(n<10000&&p+8<=b.length);const type=b.toString('ascii',p,p+4),size=b.readUInt32LE(p+4),end=p+8+size;check(end+(size&1)<=b.length&&(!(size&1)||b[end]===0));const part=b.subarray(p+8,end)
  if(type==='fmt '){check(!fmt);fmt=part}else if(type==='data'){check(!data);data=part}else if(type==='fact'){check(!fact&&size>=4&&size<=64);fact=part}
  else if(type==='LIST'){check(size>=4&&size<=META&&part.toString('ascii',0,4)==='INFO');let q=4;while(q<part.length){check(q+8<=part.length&&/^I[A-Z0-9 ]{3}$/.test(part.toString('ascii',q,q+4)));const z=part.readUInt32LE(q+4);check(q+8+z+(z&1)<=part.length);text(part.subarray(q+8,q+8+z));q+=8+z+(z&1)}}
  else if(['bext','JUNK','PAD ','cue ','smpl'].includes(type)){check(size<=META);if(type==='bext')check(size>=602);if(type==='cue ')check(size>=4&&size===4+24*part.readUInt32LE(0));if(type==='smpl')check(size>=36&&size===36+24*part.readUInt32LE(28)+part.readUInt32LE(32))}
  else profile();p=end+(size&1)
 }
 check(fmt&&data&&fmt.length>=16&&data.length>0);let tag=fmt.readUInt16LE(0);const channels=fmt.readUInt16LE(2),rate=fmt.readUInt32LE(4),average=fmt.readUInt32LE(8),align=fmt.readUInt16LE(12),bits=fmt.readUInt16LE(14)
 check(channels>=1&&channels<=32&&rate>=1000&&rate<=384000)
 if(tag===0xfffe){check(fmt.length===40&&fmt.readUInt16LE(16)===22&&fmt.readUInt16LE(18)>0&&fmt.readUInt16LE(18)<=bits&&fmt.subarray(26,40).equals(Buffer.from('000000001000800000aa00389b71','hex')));tag=fmt.readUInt16LE(24)}
 else check(fmt.length===16||fmt.length===18&&fmt.readUInt16LE(16)===0)
 check(tag===1||tag===3);check((tag===1?[8,16,24,32]:[32,64]).includes(bits));check(align===channels*bits/8&&average===rate*align&&data.length%align===0)
 if(fact)check(fact.readUInt32LE(0)===data.length/align)
}
function comments(b:Buffer,start:number,framing=false){check(b.length<=META&&start+4<=b.length);let p=start,n=b.readUInt32LE(p);p+=4;check(n<=META&&p+n+4<=b.length);text(b.subarray(p,p+n));p+=n;const count=b.readUInt32LE(p);p+=4;check(count<=10000);for(let i=0;i<count;i++){check(p+4<=b.length);n=b.readUInt32LE(p);p+=4;check(p+n<=b.length);text(b.subarray(p,p+n));p+=n}if(framing)check(p+1===b.length&&b[p]===1);else check(zeros(b.subarray(p)))}
function opusHead(b:Buffer){check(b.length>=19&&b.toString('ascii',0,8)==='OpusHead'&&b[8]>0&&b[8]<16&&b[9]>0);const family=b[18];if(family===0)check(b.length===19&&b[9]<=2);else if(family===1){check(b.length===21+b[9]&&b[9]<=8&&b[19]>0&&b[20]<=b[19]&&b[19]+b[20]<=b[9]&&b.subarray(21).every(v=>v===255||v<b[19]+b[20]))}else profile()}
function vorbisPrivate(b:Buffer,channels:number){check(b.length<=META&&b[0]===2);let p=1;const lengths:number[]=[];for(let i=0;i<2;i++){let n=0,a;do{check(p<b.length);a=b[p++];n+=a;check(n<=META)}while(a===255);lengths.push(n)}const first=b.subarray(p,p+lengths[0]);check(first.length===30&&first[0]===1&&first.toString('ascii',1,7)==='vorbis'&&first.readUInt32LE(7)===0&&first[11]===channels&&first.readUInt32LE(12)>0&&first[28]%16>=6&&first[28]>>4>=first[28]%16&&first[28]>>4<=13&&first[29]===1);p+=lengths[0];check(p+lengths[1]<b.length);const comment=b.subarray(p,p+lengths[1]);check(comment[0]===3&&comment.toString('ascii',1,7)==='vorbis');comments(comment,7,true);p+=lengths[1];const setup=b.subarray(p);check(setup.length>8&&setup[0]===5&&setup.toString('ascii',1,7)==='vorbis'&&(setup[setup.length-1]&1)===1)}
function opusPacket(b:Buffer){
 check(b.length>=1&&b.length<=1275*48+256);const config=b[0]>>>3,code=b[0]&3,ms=config>=16?2.5*2**(config&3):config>=12?10*2**(config&1):[10,20,40,60][config&3]
 let p=1,count=code===0?1:2,padding=0
 const length=()=>{check(p<b.length);const a=b[p++];if(a<252)return a;check(p<b.length);return a+4*b[p++]}
 if(code===0)check(b.length-1<=1275)
 else if(code===1)check((b.length-1)%2===0&&(b.length-1)/2<=1275)
 else if(code===2){const n=length();check(n<=1275&&p+n<=b.length&&b.length-p-n<=1275)}
 else{check(p<b.length);const flags=b[p++];count=flags&63;check(count>0&&count<=48);if(flags&64){let a;do{check(p<b.length);a=b[p++];padding+=a===255?254:a;check(padding<=b.length)}while(a===255)}const end=b.length-padding;check(p<=end);if(flags&128){let used=0;for(let i=1;i<count;i++){const n=length();check(n<=1275);used+=n}check(used<=end-p&&end-p-used<=1275)}else check((end-p)%count===0&&(end-p)/count<=1275)}
 check(ms*count<=120)
}
function oggCrc(b:Buffer){let value=0;for(let p=0;p<b.length;p++){value^=(p>=22&&p<26?0:b[p])<<24;for(let bit=0;bit<8;bit++)value=(value<<1)^((value&0x80000000)?0x04c11db7:0)}return value>>>0}
function ogg(b:Buffer){
 let p=0,sequence=0,serial=-1,pending:Buffer[]=[],pendingBytes=0,packet=0,codec='',ended=false,lastGranule=0n
 const consume=(part:Buffer)=>{if(packet===0){if(part.toString('ascii',0,8)==='OpusHead'){opusHead(part);codec='opus'}else if(part.length===30&&part[0]===1&&part.toString('ascii',1,7)==='vorbis'){check(part.readUInt32LE(7)===0&&part[11]>0&&part[11]<=32&&part.readUInt32LE(12)>0&&part[28]>>4>=part[28]%16&&part[28]%16>=6&&part[28]>>4<=13&&part[29]===1);codec='vorbis'}else profile()}
  else if(packet===1){if(codec==='opus'){check(part.toString('ascii',0,8)==='OpusTags');comments(part,8)}else{check(part[0]===3&&part.toString('ascii',1,7)==='vorbis');comments(part,7,true)}}
  else if(codec==='opus')opusPacket(part)
  else if(packet===2)check(part.length>8&&part[0]===5&&part.toString('ascii',1,7)==='vorbis'&&(part[part.length-1]&1)===1)
  else check(part.length>0&&(part[0]&1)===0);packet++}
 while(p<b.length){check(sequence<MAX_ENTRIES&&!ended&&p+27<=b.length&&b.toString('ascii',p,p+4)==='OggS'&&b[p+4]===0);const flags=b[p+5],count=b[p+26];check(!(flags&0xf8)&&p+27+count<=b.length&&Boolean(flags&1)===(pendingBytes>0));if(sequence===0){check(flags===2);serial=b.readUInt32LE(p+14)}else check(!(flags&2)&&serial===b.readUInt32LE(p+14));check(b.readUInt32LE(p+18)===sequence)
  const sizes=b.subarray(p+27,p+27+count),n=sizes.reduce((a,v)=>a+v,0),end=p+27+count+n;check(end<=b.length&&oggCrc(b.subarray(p,end))===b.readUInt32LE(p+22));const granule=b.readBigUInt64LE(p+6);if(granule!==0xffffffffffffffffn){check(granule>=lastGranule);lastGranule=granule}let q=p+27+count
  for(const z of sizes){pending.push(b.subarray(q,q+z));q+=z;pendingBytes+=z;check(pendingBytes<=META);if(z<255){consume(Buffer.concat(pending,pendingBytes));pending=[];pendingBytes=0}}
  if(flags&4){check(!pendingBytes);ended=true}p=end;sequence++
 }
 check(ended&&p===b.length&&packet>=(codec==='opus'?3:4))
}

type Box={type:string;start:number;data:number;end:number}
function boxes(b:Buffer,start:number,end:number,top=false):Box[]{let p=start;const out:Box[]=[];while(p<end){check(out.length<20000&&p+8<=end);const size=b.readUInt32BE(p),type=b.toString('latin1',p+4,p+8);let n=size,h=8;if(size===1){check(p+16<=end);n=u64(b,p+8);h=16}else if(!size){check(top&&type==='mdat');n=end-p}check(n>=h&&p+n<=end);out.push({type,start:p,data:p+h,end:p+n});p+=n}check(p===end);return out}
const only=(list:Box[],type:string)=>{const found=list.filter(x=>x.type===type);check(found.length===1);return found[0]}
const body=(b:Buffer,x:Box)=>b.subarray(x.data,x.end)
function full(b:Buffer,x:Box,versions:number[]=[0]){check(x.end-x.data>=4&&versions.includes(b[x.data]));return x.data+4}
function covered(b:Buffer,ranges:[number,number][],media:Box[]){check(ranges.length>0);ranges.sort((a,z)=>a[0]-z[0]);for(let i=1;i<ranges.length;i++)check(ranges[i][0]>=ranges[i-1][1]);for(const m of media){let cursor=m.data;for(const [a,z]of ranges.filter(([a,z])=>a>=m.data&&z<=m.end)){check(a>=cursor&&a-cursor<=64&&zeros(b.subarray(cursor,a)));cursor=z}check(m.end-cursor<=64&&zeros(b.subarray(cursor,m.end)))}for(const [a,z]of ranges)check(a<z&&media.some(m=>a>=m.data&&z<=m.end))}
function dref(b:Buffer,x:Box){const p=full(b,x);check(p+4<=x.end);const refs=boxes(b,p+4,x.end);check(refs.length===b.readUInt32BE(p)&&refs.length>0&&refs.length<=16);for(const ref of refs){check(ref.type==='url '&&ref.end-ref.data===4&&b.readUInt32BE(ref.data)===1)}}
function av1(b:Buffer,dimensions?:{width:number;height:number}){
 check(b.length>0);let p=0,count=0,frame=false,sequence=false
 while(p<b.length){check(++count<100000);const h=b[p++],type=(h>>>3)&15;check(!(h&0x81)&&type>0&&([1,2,3,4,5,6,7,8,15].includes(type))&&(h&2));if(h&4){check(p<b.length&&!(b[p]&7));p++}let n=0,m=1,done=false;for(let i=0;i<8;i++){check(p<b.length);const a=b[p++];n+=(a&127)*m;check(Number.isSafeInteger(n)&&n<=MAX);if(!(a&128)){done=true;break}m*=128}check(done&&p+n<=b.length)
  if([3,6,7].includes(type)){check(n>0);frame=true}
  if(type===1&&dimensions){const data=b.subarray(p,p+n);let bit=0;const take=(length:number)=>{check(bit+length<=data.length*8);let value=0;for(let i=0;i<length;i++){value=value*2+((data[bit>>>3]>>>(7-(bit&7)))&1);bit++}return value};check(take(3)<=2);const still=take(1),reduced=take(1);if(reduced){check(still===1);take(5)}else{const timing=take(1);let decoder=false,delayLength=0;if(timing){check(take(32)>0&&take(32)>0);if(take(1)){let leading=0;while(take(1)===0)check(++leading<32);take(leading)}decoder=!!take(1);if(decoder){delayLength=take(5)+1;check(take(32)>0);take(5);take(5)}}const initial=take(1),ops=take(5)+1;for(let i=0;i<ops;i++){take(12);if(take(5)>7)take(1);if(decoder&&take(1)){take(delayLength);take(delayLength);take(1)}if(initial&&take(1))take(4)}}const wb=take(4)+1,hb=take(4)+1,width=take(wb)+1,height=take(hb)+1;check(width<=dimensions.width&&height<=dimensions.height&&width*height<=32000000,'UPLOAD_MEDIA_LIMIT');sequence=true}
  p+=n
 }
 check(p===b.length&&frame&&(!dimensions||sequence))
}
function esds(b:Buffer){
 const descriptor=(start:number,end:number)=>{check(start+2<=end);const tag=b[start++];let size=0,complete=false;for(let i=0;i<4;i++){check(start<end);const a=b[start++];size=size*128+(a&127);if(!(a&128)){complete=true;break}}check(complete&&size<=META&&start+size<=end);return{tag,start,end:start+size}}
 const es=descriptor(4,b.length);check(es.tag===3&&es.end===b.length&&es.start+3<es.end&&b.readUInt16BE(es.start)>0);const flags=b[es.start+2];check(!(flags&0xe0),'UPLOAD_MEDIA_PROFILE_UNSUPPORTED')
 const config=descriptor(es.start+3,es.end);check(config.tag===4&&config.start+13<config.end&&b[config.start]===0x40&&(b[config.start+1]>>>2)===5&&(b[config.start+1]&1)===1)
 const specific=descriptor(config.start+13,config.end);check(specific.tag===5&&specific.end===config.end&&specific.end-specific.start>=2&&specific.end-specific.start<=64)
 const asc=b.subarray(specific.start,specific.end);let pos=0;const bits=(n:number)=>{check(pos+n<=asc.length*8);let value=0;for(let i=0;i<n;i++){value=value*2+((asc[pos>>>3]>>>(7-(pos&7)))&1);pos++}return value};let object=bits(5);if(object===31)object=32+bits(6);const frequency=()=>{const index=bits(4);check(index<=12||index===15);if(index===15)check(bits(24)>0)};frequency();const channels=bits(4);check(channels>0&&channels<=7);if(object===5||object===29){frequency();object=bits(5)}check([1,2,3,4].includes(object),'UPLOAD_MEDIA_PROFILE_UNSUPPORTED');bits(1);if(bits(1))bits(14);bits(1)
 const sl=descriptor(config.end,es.end);check(sl.tag===6&&sl.end===es.end&&sl.end-sl.start===1&&b[sl.start]===2)
}
function codecConfig(b:Buffer,entry:Box,kind:string):number{
 const p=entry.data;check(entry.end-p>=8&&zeros(b.subarray(p,p+6)));const reference=b.readUInt16BE(p+6);check(reference>0)
 const audio=['mp4a','alac','Opus','sowt','twos','lpcm'].includes(entry.type),video=['avc1','avc3','hvc1','hev1','vp09','av01','jpeg'].includes(entry.type)
 check(kind==='soun'?audio:kind==='vide'&&video)
 let children:Box[]=[]
 if(audio){check(entry.end-p>=28);const version=b.readUInt16BE(p+8);if(version>1)profile();check(b.readUInt16BE(p+16)>0&&b.readUInt16BE(p+16)<=32&&b.readUInt32BE(p+24)>0);const offset=version===1?44:28;check(entry.end-p>=offset);children=boxes(b,p+offset,entry.end)}
 else{check(entry.end-p>=78&&b.readUInt16BE(p+24)>0&&b.readUInt16BE(p+26)>0&&b.readUInt16BE(p+24)<=16384&&b.readUInt16BE(p+26)<=16384);children=boxes(b,p+78,entry.end)}
 const allowed=new Set(['esds','alac','dOps','avcC','hvcC','vpcC','av1C','btrt','pasp','clap','colr','fiel','gama','chan','enda','wave','glbl']);for(const x of children)check(allowed.has(x.type),'UPLOAD_MEDIA_PROFILE_UNSUPPORTED')
 if(entry.type==='mp4a'){const x=only(children,'esds');check(x.end-x.data>=8);full(b,x);esds(body(b,x))}
 else if(entry.type==='alac')check(only(children,'alac').end-only(children,'alac').data>=24)
 else if(entry.type==='Opus'){const x=only(children,'dOps');check(x.end-x.data>=11&&b[x.data]===0&&b[x.data+1]>0)}
 else if(['avc1','avc3'].includes(entry.type)){const x=only(children,'avcC'),c=body(b,x);check(c.length>=7&&c[0]===1&&(c[4]&3)!==2);let q=6;const sps=c[5]&31;check(sps>0);for(let i=0;i<sps;i++){check(q+2<=c.length);const n=c.readUInt16BE(q);q+=2;check(n>0&&q+n<=c.length&&(c[q]&31)===7);q+=n}check(q<c.length);const pps=c[q++];check(pps>0);for(let i=0;i<pps;i++){check(q+2<=c.length);const n=c.readUInt16BE(q);q+=2;check(n>0&&q+n<=c.length&&(c[q]&31)===8);q+=n}if(q<c.length){check([100,110,122,144].includes(c[1])&&q+4<=c.length);q+=3;const count=c[q++];for(let i=0;i<count;i++){check(q+2<=c.length);const n=c.readUInt16BE(q);q+=2;check(q+n<=c.length);q+=n}}check(q===c.length)}
 else if(['hvc1','hev1'].includes(entry.type)){const c=body(b,only(children,'hvcC'));check(c.length>=23&&c[0]===1);let q=23;for(let i=0;i<c[22];i++){check(q+3<=c.length);q++;const count=c.readUInt16BE(q);q+=2;for(let z=0;z<count;z++){check(q+2<=c.length);const n=c.readUInt16BE(q);q+=2;check(n>=2&&q+n<=c.length);q+=n}}check(q===c.length)}
 else if(entry.type==='av01'){const c=body(b,only(children,'av1C'));check(c.length>=4&&c[0]===0x81)}
 else if(entry.type==='vp09')check(body(b,only(children,'vpcC')).length>=12)
 return reference
}
function bmff(b:Buffer,extension:string){
 const top=boxes(b,0,b.length,true),ftyp=top.find(x=>x.type==='ftyp');check(top.every(x=>['ftyp','moov','mdat','free','skip','wide','meta'].includes(x.type)),'UPLOAD_MEDIA_PROFILE_UNSUPPORTED')
 if(ftyp){check(top.filter(x=>x.type==='ftyp').length===1&&ftyp.end-ftyp.data>=8&&(ftyp.end-ftyp.data)%4===0);const brand=b.toString('ascii',ftyp.data,ftyp.data+4);if(extension==='avif'){check(brand==='avif');avif(b,top);return}check(/^(?:isom|iso[2-9]|mp4[12]|M4[ABV] |avc1|qt  |MSNV|3gp[4-9]|3g2[ab])$/.test(brand),'UPLOAD_MEDIA_PROFILE_UNSUPPORTED')}
 else check(extension==='mov')
 const moov=only(top,'moov'),media=top.filter(x=>x.type==='mdat');check(media.length>0);const moovChildren=boxes(b,moov.data,moov.end),movie=only(moovChildren,'mvhd');full(b,movie,[0,1]);check(movie.end-movie.data>=(b[movie.data]===1?112:100));check(b.readUInt32BE(movie.data+(b[movie.data]===1?20:12))>0)
 for(const x of moovChildren)check(['mvhd','trak','udta','meta','iods'].includes(x.type),'UPLOAD_MEDIA_PROFILE_UNSUPPORTED')
 const tracks=moovChildren.filter(x=>x.type==='trak');check(tracks.length>0&&tracks.length<=32);const ranges:[number,number][]=[],trackIds=new Set<number>();let hasAudio=false
 for(const track of tracks){const a=boxes(b,track.data,track.end);for(const x of a)check(['tkhd','mdia','edts','udta','meta'].includes(x.type),'UPLOAD_MEDIA_PROFILE_UNSUPPORTED');const tkhd=only(a,'tkhd'),tk=full(b,tkhd,[0,1]);check(tkhd.end-tk>=((b[tkhd.data]===1)?88:76));const trackId=b.readUInt32BE(tkhd.data+(b[tkhd.data]===1?20:12));check(trackId>0&&!trackIds.has(trackId));trackIds.add(trackId)
  const mdia=only(a,'mdia'),mc=boxes(b,mdia.data,mdia.end);for(const x of mc)check(['mdhd','hdlr','minf','elng'].includes(x.type),'UPLOAD_MEDIA_PROFILE_UNSUPPORTED');const mdhd=only(mc,'mdhd');full(b,mdhd,[0,1]);check(mdhd.end-mdhd.data>=(b[mdhd.data]===1?36:24)&&b.readUInt32BE(mdhd.data+(b[mdhd.data]===1?20:12))>0);const handler=only(mc,'hdlr');check(handler.end-handler.data>=24);full(b,handler);const kind=b.toString('ascii',handler.data+8,handler.data+12);check(['soun','vide'].includes(kind),'UPLOAD_MEDIA_PROFILE_UNSUPPORTED');if(kind==='soun')hasAudio=true;if(extension==='m4a')check(kind==='soun')
  const minf=only(mc,'minf'),mi=boxes(b,minf.data,minf.end);for(const x of mi)check(['smhd','vmhd','dinf','stbl','hdlr'].includes(x.type),'UPLOAD_MEDIA_PROFILE_UNSUPPORTED');const dinf=only(mi,'dinf'),dr=boxes(b,dinf.data,dinf.end);dref(b,only(dr,'dref'));const stbl=only(mi,'stbl'),st=boxes(b,stbl.data,stbl.end);for(const x of st)check(['stsd','stts','ctts','stsc','stsz','stco','co64','stss','sdtp','sgpd','sbgp'].includes(x.type),'UPLOAD_MEDIA_PROFILE_UNSUPPORTED')
  const sd=only(st,'stsd'),sp=full(b,sd);check(sp+4<=sd.end);const entries=boxes(b,sp+4,sd.end);check(entries.length===b.readUInt32BE(sp)&&entries.length>0&&entries.length<=16);for(const entry of entries)check(codecConfig(b,entry,kind)<=dr.length)
  const sz=only(st,'stsz'),zp=full(b,sz);check(zp+8<=sz.end);const uniform=b.readUInt32BE(zp),count=b.readUInt32BE(zp+4);check(count>0&&count<=MAX_ENTRIES&&sz.end-zp===8+(uniform?0:4*count));const sizes=Array.from({length:count},(_,i)=>uniform||b.readUInt32BE(zp+8+4*i));check(sizes.every(n=>n>0&&n<=MAX))
  const ts=only(st,'stts'),tp=full(b,ts);check(tp+4<=ts.end);const times=b.readUInt32BE(tp);check(times<=MAX_ENTRIES&&ts.end-tp===4+8*times);let samples=0,duration=0;for(let i=0;i<times;i++){const n=b.readUInt32BE(tp+4+8*i);check(n>0);samples+=n;duration+=n*b.readUInt32BE(tp+8+8*i);check(Number.isSafeInteger(duration))}check(samples===count&&duration>0)
  for(const extra of st.filter(x=>['ctts','stss','sdtp','sgpd','sbgp'].includes(x.type))){const ep=full(b,extra,extra.type==='sgpd'?[0,1,2]:extra.type==='ctts'||extra.type==='sbgp'?[0,1]:[0]);if(extra.type==='sdtp'){check(extra.end-ep===count);continue}check(ep+4<=extra.end)
   if(extra.type==='ctts'||extra.type==='stss'){const n=b.readUInt32BE(ep),width=extra.type==='ctts'?8:4;check(n<=MAX_ENTRIES&&extra.end-ep===4+width*n);let total=0,last=0;for(let i=0;i<n;i++){const value=b.readUInt32BE(ep+4+width*i);if(extra.type==='ctts')total+=value;else{check(value>last&&value<=count);last=value}}if(extra.type==='ctts')check(total===count)}
   else{const grouping=b.toString('ascii',ep,ep+4);check(['roll','prol','rap ','sync'].includes(grouping),'UPLOAD_MEDIA_PROFILE_UNSUPPORTED');let q=ep+4;if(extra.type==='sbgp'){if(b[extra.data]===1)q+=4;check(q+4<=extra.end);const n=b.readUInt32BE(q);q+=4;check(n<=MAX_ENTRIES&&extra.end-q===8*n);let total=0;for(let i=0;i<n;i++)total+=b.readUInt32BE(q+8*i);check(total===count)}else{let fixed=grouping==='roll'||grouping==='prol'?2:1;if(b[extra.data]>=1){check(q+4<=extra.end);fixed=b.readUInt32BE(q);q+=4}if(b[extra.data]===2)q+=4;check(q+4<=extra.end);const n=b.readUInt32BE(q);q+=4;check(n<=MAX_ENTRIES);for(let i=0;i<n;i++){let length=fixed;if(!length){check(q+4<=extra.end);length=b.readUInt32BE(q);q+=4}check(length===(grouping==='roll'||grouping==='prol'?2:1)&&q+length<=extra.end);q+=length}check(q===extra.end)}}
  }
  const sc=only(st,'stsc'),cp=full(b,sc);check(cp+4<=sc.end);const mappings=b.readUInt32BE(cp);check(mappings>0&&mappings<=MAX_ENTRIES&&sc.end-cp===4+12*mappings);const map=Array.from({length:mappings},(_,i)=>({first:b.readUInt32BE(cp+4+12*i),samples:b.readUInt32BE(cp+8+12*i),description:b.readUInt32BE(cp+12+12*i)}));check(map[0].first===1&&map.every((x,i)=>x.samples>0&&x.description>0&&x.description<=entries.length&&(!i||x.first>map[i-1].first)))
  const offsets=st.filter(x=>['stco','co64'].includes(x.type));check(offsets.length===1);const off=offsets[0],op=full(b,off);check(op+4<=off.end);const chunks=b.readUInt32BE(op),width=off.type==='co64'?8:4;check(chunks>0&&chunks<=MAX_ENTRIES&&off.end-op===4+width*chunks&&map[map.length-1].first<=chunks);let sample=0,mapping=0
  for(let i=0;i<chunks;i++){if(mapping+1<map.length&&i+1>=map[mapping+1].first)mapping++;const offset=width===8?u64(b,op+4+i*8):b.readUInt32BE(op+4+i*4);let length=0;for(let k=0;k<map[mapping].samples;k++){check(sample<count);length+=sizes[sample++];check(length<=MAX)}ranges.push([offset,offset+length])}check(sample===count)
 }
 check(extension!=='m4a'||hasAudio);covered(b,ranges,media)
 // Metadata is never executed or followed; reject uncommon active containers.
 const inspect=(list:Box[],depth:number)=>{check(depth<=12);for(const x of list){if(['udta','meta','ilst'].includes(x.type)){check(x.end-x.data<=META);inspect(boxes(b,x.data+(x.type==='meta'?4:0),x.end),depth+1)}else if(['uuid','sinf','schi','pssh','rdrf','rmra','rmda','load'].includes(x.type))profile()}}
 inspect([...moovChildren,...top.filter(x=>x.type==='meta')],0)
}

function avif(b:Buffer,top:Box[]){
 check(!top.some(x=>x.type==='moov'));const meta=only(top,'meta'),p=full(b,meta);const parts=boxes(b,p,meta.end);check(parts.every(x=>['hdlr','pitm','iloc','iinf','iprp','idat','free'].includes(x.type)),'UPLOAD_MEDIA_PROFILE_UNSUPPORTED')
 const primary=only(parts,'pitm'),pp=full(b,primary,[0,1]),primaryId=b[primary.data]===0?b.readUInt16BE(pp):b.readUInt32BE(pp);check(primaryId>0&&primary.end-pp===(b[primary.data]===0?2:4))
 const info=only(parts,'iinf'),ip=full(b,info,[0,1]),iw=b[info.data]===0?2:4;check(ip+iw<=info.end);const entries=boxes(b,ip+iw,info.end);check(entries.length===1&&(iw===2?b.readUInt16BE(ip):b.readUInt32BE(ip))===1);const e=entries[0];check(e.type==='infe');const ep=full(b,e,[2,3]),ew=b[e.data]===2?2:4;check(ep+ew+7<=e.end);check((ew===2?b.readUInt16BE(ep):b.readUInt32BE(ep))===primaryId&&b.readUInt16BE(ep+ew)===0&&b.toString('ascii',ep+ew+2,ep+ew+6)==='av01','UPLOAD_MEDIA_PROFILE_UNSUPPORTED')
 const properties=only(parts,'iprp'),pc=boxes(b,properties.data,properties.end),ipco=only(pc,'ipco'),props=boxes(b,ipco.data,ipco.end),ipma=only(pc,'ipma');check(props.length>0&&props.length<=127);const ap=full(b,ipma,[0,1]),wide=!!(b[ipma.data+3]&1);check((b.readUIntBE(ipma.data+1,3)&~1)===0&&ap+4<=ipma.end&&b.readUInt32BE(ap)===1);let q=ap+4;const idWidth=b[ipma.data]===0?2:4;check(q+idWidth+1<=ipma.end&&(idWidth===2?b.readUInt16BE(q):b.readUInt32BE(q))===primaryId);q+=idWidth;const n=b[q++],selected:Box[]=[];for(let i=0;i<n;i++){check(q+(wide?2:1)<=ipma.end);const index=(wide?b.readUInt16BE(q):b[q])&(wide?32767:127);q+=wide?2:1;check(index>0&&index<=props.length);selected.push(props[index-1])}check(q===ipma.end)
 const dimensions=only(selected,'ispe'),dp=full(b,dimensions);check(dimensions.end-dp===8);const w=b.readUInt32BE(dp),h=b.readUInt32BE(dp+4);check(w>0&&h>0&&w<=16384&&h<=16384&&w*h<=32000000);const config=body(b,only(selected,'av1C'));check(config.length>=4&&config[0]===0x81)
 for(const prop of props)check(['ispe','av1C','pixi','colr','irot','imir','clap','pasp'].includes(prop.type),'UPLOAD_MEDIA_PROFILE_UNSUPPORTED')
 const iloc=only(parts,'iloc'),lp=full(b,iloc,[0,1,2]);check(lp+4<=iloc.end);const ow=b[lp]>>4,lw=b[lp]&15,bw=b[lp+1]>>4,ix=b[iloc.data]===0?0:b[lp+1]&15;check([0,4,8].includes(ow)&&[4,8].includes(lw)&&[0,4,8].includes(bw)&&[0,4,8].includes(ix));let z=lp+2;const cw=b[iloc.data]<2?2:4;check(z+cw<=iloc.end&&(cw===2?b.readUInt16BE(z):b.readUInt32BE(z))===1);z+=cw
 const read=(width:number)=>{check(z+width<=iloc.end);const n=width===8?u64(b,z):width===4?b.readUInt32BE(z):width===2?b.readUInt16BE(z):0;z+=width;return n}
 check(read(b[iloc.data]<2?2:4)===primaryId);const method=b[iloc.data]===0?0:read(2);check(method===0||method===1);check(read(2)===0);const base=read(bw),count=read(2);check(count>0&&count<=64);const media=method===1?parts.filter(x=>x.type==='idat'):top.filter(x=>x.type==='mdat');check(media.length===1);const extents:[number,number][]=[],pieces:Buffer[]=[];for(let i=0;i<count;i++){if(ix)read(ix);const offset=read(ow),length=read(lw),start=(method===1?media[0].data:0)+base+offset;check(length>0&&start>=media[0].data&&start+length<=media[0].end);extents.push([start,start+length]);pieces.push(b.subarray(start,start+length))}check(z===iloc.end);covered(b,extents,media);av1(Buffer.concat([config.subarray(4),...pieces]),{width:w,height:h})
}

type Element={id:number;data:number;end:number;unknown:boolean}
function vint(b:Buffer,p:number,end:number,id=false):{n:number;width:number;unknown:boolean}{check(p<end);let width=1,mask=128;while(width<=8&&!(b[p]&mask)){width++;mask>>=1}check(width<=8&&(!id||width<=4)&&p+width<=end);let n=id?b[p]:b[p]&(mask-1),all=!id&&n===mask-1;for(let i=1;i<width;i++){n=n*256+b[p+i];all=all&&b[p+i]===255}check(all||Number.isSafeInteger(n));return{n:all?0:n,width,unknown:all}}
function elements(b:Buffer,start:number,end:number,allowUnknown=false):Element[]{const out:Element[]=[];let p=start;while(p<end){check(out.length<MAX_ENTRIES);const id=vint(b,p,end,true);p+=id.width;const size=vint(b,p,end);p+=size.width;check(size.unknown?allowUnknown&&[0x18538067,0x1f43b675].includes(id.n):size.n<=MAX);let finish=size.unknown?end:p+size.n;check(finish<=end)
 if(size.unknown&&id.n===0x1f43b675){let q=p,count=0;while(q<end){check(++count<=MAX_ENTRIES);const child=vint(b,q,end,true);if([0x114d9b74,0x1549a966,0x1654ae6b,0x1f43b675,0x1c53bb6b,0x1254c367].includes(child.n))break;const length=vint(b,q+child.width,end);check(!length.unknown&&length.n<=MAX);q+=child.width+length.width+length.n;check(q<=end)}finish=q;check(finish>p)}
 out.push({id:id.n,data:p,end:finish,unknown:size.unknown});p=finish}check(p===end);return out}
const number=(b:Buffer,e:Element)=>{check(e.end-e.data>=1&&e.end-e.data<=8);let n=0;for(let p=e.data;p<e.end;p++){n=n*256+b[p];check(Number.isSafeInteger(n))}return n}
function webm(b:Buffer){
 const root=elements(b,0,b.length,true);check(root.length===2&&root[0].id===0x1a45dfa3&&!root[0].unknown&&root[1].id===0x18538067);const header=elements(b,root[0].data,root[0].end);const value=(items:Element[],id:number)=>{const a=items.filter(e=>e.id===id);check(a.length===1);return a[0]};check(bodyElement(b,value(header,0x4282))==='webm');for(const e of header){check([0x4286,0x42f7,0x42f2,0x42f3,0x4282,0x4287,0x4285,0xec,0xbf].includes(e.id));if(e.id===0x4286||e.id===0x42f7)check(number(b,e)===1);if(e.id===0x42f2)check(number(b,e)<=4);if(e.id===0x42f3)check(number(b,e)<=8);if(e.id===0x4285)check(number(b,e)<=4)}
 const segment=elements(b,root[1].data,root[1].end,true),trackRoot=value(segment,0x1654ae6b),tracks=new Map<number,{codec:string;width:number;height:number}>();let packets=0
 for(const e of segment)check([0x114d9b74,0x1549a966,0x1654ae6b,0x1f43b675,0x1c53bb6b,0x1254c367,0xec,0xbf].includes(e.id),'UPLOAD_MEDIA_PROFILE_UNSUPPORTED')
 for(const entry of elements(b,trackRoot.data,trackRoot.end)){check(entry.id===0xae);const fields=elements(b,entry.data,entry.end);check(!fields.some(e=>[0x6d80,0x3b4040,0x26b240].includes(e.id)),'UPLOAD_MEDIA_PROFILE_UNSUPPORTED');const id=number(b,value(fields,0xd7)),kind=number(b,value(fields,0x83)),codec=bodyElement(b,value(fields,0x86));check(id>0&&id<=127&&!tracks.has(id)&&tracks.size<32);check(kind===1?['V_VP8','V_VP9','V_AV1'].includes(codec):kind===2&&['A_OPUS','A_VORBIS'].includes(codec),'UPLOAD_MEDIA_PROFILE_UNSUPPORTED');let width=0,height=0
  if(kind===1){const video=value(fields,0xe0),v=elements(b,video.data,video.end);width=number(b,value(v,0xb0));height=number(b,value(v,0xba));check(width>0&&height>0&&width<=16384&&height<=16384&&width*height<=64000000)}
  else{const audio=value(fields,0xe1),a=elements(b,audio.data,audio.end),channels=number(b,value(a,0x9f));check(channels>0&&channels<=32);const frequency=a.filter(e=>e.id===0xb5);check(frequency.length<=1);if(frequency.length){const f=frequency[0],length=f.end-f.data;check(length===4||length===8);const rate=length===4?b.readFloatBE(f.data):b.readDoubleBE(f.data);check(Number.isFinite(rate)&&rate>=1000&&rate<=384000)}const privateData=value(fields,0x63a2),c=b.subarray(privateData.data,privateData.end);if(codec==='A_OPUS'){opusHead(c);check(c[9]===channels)}else vorbisPrivate(c,channels)}tracks.set(id,{codec,width,height})
 }
 const block=(e:Element)=>{let p=e.data;const tn=vint(b,p,e.end);p+=tn.width;check(!tn.unknown&&tracks.has(tn.n)&&p+3<e.end);p+=2;const flags=b[p++],lacing=(flags>>1)&3;let count=1;const lengths:number[]=[];if(lacing){check(p<e.end);count=b[p++]+1;if(lacing===1){for(let i=1;i<count;i++){let n=0,a;do{check(p<e.end);a=b[p++];n+=a;check(n<=MAX)}while(a===255);lengths.push(n)}}else if(lacing===3){const first=vint(b,p,e.end);check(!first.unknown);p+=first.width;lengths.push(first.n);for(let i=2;i<count;i++){const delta=vint(b,p,e.end);check(!delta.unknown&&delta.width<=4);p+=delta.width;const n=lengths[lengths.length-1]+delta.n-(2**(7*delta.width-1)-1);check(n>=0&&n<=MAX);lengths.push(n)}}}
  if(lacing===2){check((e.end-p)%count===0);for(let i=0;i<count;i++)lengths.push((e.end-p)/count)}else lengths.push(e.end-p-lengths.reduce((a,n)=>a+n,0));check(lengths.length===count&&lengths.every(n=>n>0&&n<=8*1024*1024)&&lengths.reduce((a,n)=>a+n,0)===e.end-p)
  for(const n of lengths){const packet=b.subarray(p,p+n),track=tracks.get(tn.n)!;if(track.codec==='A_OPUS')opusPacket(packet);if(track.codec==='A_VORBIS')check(!(packet[0]&1));if(track.codec==='V_VP8'){check(n>=3);if(!(packet[0]&1))check(n>=10&&packet.toString('hex',3,6)==='9d012a'&&(packet.readUInt16LE(6)&16383)===track.width&&(packet.readUInt16LE(8)&16383)===track.height)}if(track.codec==='V_VP9')check((packet[0]&0xc0)===0x80);if(track.codec==='V_AV1')av1(packet);p+=n;check(++packets<=MAX_ENTRIES)}check(p===e.end)}
 for(const cluster of segment.filter(e=>e.id===0x1f43b675)){const items=elements(b,cluster.data,cluster.end);number(b,value(items,0xe7));for(const item of items){if(item.id===0xa3)block(item);else if(item.id===0xa0){const group=elements(b,item.data,item.end);check(group.every(e=>[0xa1,0x9b,0xfb,0x75a2].includes(e.id)));block(value(group,0xa1))}else check([0xe7,0xa7,0xab,0xec,0xbf].includes(item.id),'UPLOAD_MEDIA_PROFILE_UNSUPPORTED')}}check(tracks.size>0&&packets>0)
}
function bodyElement(b:Buffer,e:Element){check(e.end-e.data<=META);return b.toString('utf8',e.data,e.end)}
/** Conservative header-only expansion charge for archive preflight. The full
 * validator still runs afterwards; this does not certify compressed pixels. */
export function avifDecodedPixelBudget(bytes:Buffer):number{
 try{check(Buffer.isBuffer(bytes)&&bytes.length>=24&&bytes.length<=MAX);const top=boxes(bytes,0,bytes.length,true),ftyp=only(top,'ftyp');check(bytes.toString('ascii',ftyp.data,ftyp.data+4)==='avif');const meta=only(top,'meta'),parts=boxes(bytes,full(bytes,meta),meta.end),iprp=only(parts,'iprp'),properties=boxes(bytes,iprp.data,iprp.end),ipco=only(properties,'ipco');let total=0,count=0
  for(const e of boxes(bytes,ipco.data,ipco.end).filter(e=>e.type==='ispe')){const p=full(bytes,e);check(e.end-p===8);const w=bytes.readUInt32BE(p),h=bytes.readUInt32BE(p+4);check(w>0&&h>0&&w<=16384&&h<=16384);total+=w*h;check(++count<=8&&total<=32000000,'UPLOAD_MEDIA_LIMIT')}check(count>0);return total
 }catch(error){if(error instanceof MediaValidationError)throw error;return bad()}
}
export function validateMedia(bytes:Buffer,extension:string):void{
 if(!Buffer.isBuffer(bytes)||bytes.length<4||bytes.length>MAX)bad('UPLOAD_MEDIA_LIMIT')
 try{switch(extension){case'mp3':mp3(bytes);break;case'wav':wave(bytes);break;case'ogg':ogg(bytes);break;case'm4a':case'mp4':case'mov':case'avif':bmff(bytes,extension);break;case'webm':webm(bytes);break;default:profile()}}
 catch(error){if(error instanceof MediaValidationError)throw error;bad()}
}
