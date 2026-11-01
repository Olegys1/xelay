// Generated framed streams/container tables, never a decoder or network call.
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateMedia, avifDecodedPixelBudget, MediaValidationError } from '../../server/uploadMediaValidation.ts'
const invalid=(b,ext)=>assert.throws(()=>validateMedia(b,ext),e=>e instanceof MediaValidationError&&e.status===422&&/^UPLOAD_MEDIA_/.test(e.code))
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b}
const le32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b}
const box=(type,...payload)=>{const data=Buffer.concat(payload.map(p=>Buffer.isBuffer(p)?p:Buffer.from(p,'latin1')));return Buffer.concat([u32(data.length+8),Buffer.from(type,'latin1'),data])}
const full=(type,payload=Buffer.alloc(0),version=0,flags=0)=>box(type,Buffer.from([version,flags>>>16,(flags>>>8)&255,flags&255]),payload)
function mp3(){const frame=Buffer.alloc(417);Buffer.from([0xff,0xfb,0x90,0x00]).copy(frame);return Buffer.concat([frame,frame])}
function id3(data){const frame=Buffer.concat([Buffer.from('TIT2'),u32(data.length),Buffer.alloc(2),data]),size=frame.length;return Buffer.concat([Buffer.from([73,68,51,3,0,0,(size>>>21)&127,(size>>>14)&127,(size>>>7)&127,size&127]),frame])}
test('MPEG Layer III requires complete consecutive frames and permits bounded ordinary text tags',()=>{
 validateMedia(mp3(),'mp3');validateMedia(Buffer.concat([id3(Buffer.from('\x03Lecture recording')),mp3()]),'mp3')
 const tail=Buffer.alloc(128);tail.write('TAG');tail.write('Lecture',3);validateMedia(Buffer.concat([mp3(),tail]),'mp3')
 for(const b of [Buffer.from([255,251,144,0]),mp3().subarray(0,-1),Buffer.concat([mp3(),Buffer.from('<script>bad()</script>')])])invalid(b,'mp3')
 const badRate=mp3();badRate[2]=0x9c;invalid(badRate,'mp3')
 const changed=mp3();changed[417+2]=0x94;invalid(changed,'mp3')
})
test('ID3 lengths and frame flags are structural, with encryption and external/object tags refused',()=>{
 const truncated=id3(Buffer.from('\x03Title'));truncated[9]=127;invalid(Buffer.concat([truncated,mp3()]),'mp3')
 for(const name of ['GEOB','PRIV','WXXX']){const tag=id3(Buffer.from('\x03Content'));tag.write(name,10);invalid(Buffer.concat([tag,mp3()]),'mp3')}
 const encrypted=id3(Buffer.from('\x03Title'));encrypted[19]=0x40;invalid(Buffer.concat([encrypted,mp3()]),'mp3')
 invalid(Buffer.concat([id3(Buffer.from('\x03<script>bad()</script>')),mp3()]),'mp3')
})
function wav(){const fmt=Buffer.alloc(16);fmt.writeUInt16LE(1);fmt.writeUInt16LE(1,2);fmt.writeUInt32LE(8000,4);fmt.writeUInt32LE(16000,8);fmt.writeUInt16LE(2,12);fmt.writeUInt16LE(16,14);const chunk=(type,data)=>Buffer.concat([Buffer.from(type),le32(data.length),data,data.length%2?Buffer.alloc(1):Buffer.alloc(0)]),data=Buffer.concat([Buffer.from('WAVE'),chunk('fmt ',fmt),chunk('data',Buffer.alloc(160))]);return Buffer.concat([Buffer.from('RIFF'),le32(data.length),data])}
test('generated PCM WAVE validates RIFF boundaries, format arithmetic and complete sample blocks',()=>{
 const good=wav();validateMedia(good,'wav')
 for(const b of [good.subarray(0,-1),Buffer.concat([good,Buffer.from('MZextra')])])invalid(b,'wav')
 const align=Buffer.from(good);align.writeUInt16LE(3,32);invalid(align,'wav')
 const size=Buffer.from(good);size.writeUInt32LE(159,40);size.writeUInt32LE(size.length-9,4);invalid(size,'wav')
 const codec=Buffer.from(good);codec.writeUInt16LE(0x55,20);invalid(codec,'wav')
})
function opusHead(){const b=Buffer.alloc(19);b.write('OpusHead');b[8]=1;b[9]=2;b.writeUInt16LE(312,10);b.writeUInt32LE(48000,12);return b}
const opusTags=()=>Buffer.concat([Buffer.from('OpusTags'),le32(7),Buffer.from('fixture'),le32(0)])
function crc(b){let c=0;for(let p=0;p<b.length;p++){c^=(p>=22&&p<26?0:b[p])<<24;for(let bit=0;bit<8;bit++)c=(c<<1)^((c&0x80000000)?0x04c11db7:0)}return c>>>0}
function page(packet,sequence,flags,granule=0){const sizes=[];for(let n=packet.length;n>=255;n-=255)sizes.push(255);sizes.push(packet.length%255);const b=Buffer.alloc(27+sizes.length+packet.length);b.write('OggS');b[5]=flags;b.writeBigUInt64LE(BigInt(granule),6);b.writeUInt32LE(42,14);b.writeUInt32LE(sequence,18);b[26]=sizes.length;Buffer.from(sizes).copy(b,27);packet.copy(b,27+sizes.length);b.writeUInt32LE(crc(b),22);return b}
const ogg=()=>Buffer.concat([page(opusHead(),0,2),page(opusTags(),1,0),page(Buffer.from([0xf8,0xff,0xfe]),2,4,960)])
test('generated Ogg Opus pages require CRC, sequence, proper headers, packet lacing and EOS',()=>{
 validateMedia(ogg(),'ogg');const bytes=ogg()
 for(const b of [bytes.subarray(0,-1),Buffer.concat([bytes,Buffer.from('PK\x03\x04')])])invalid(b,'ogg')
 const checksum=Buffer.from(bytes);checksum[checksum.length-1]^=1;invalid(checksum,'ogg')
 invalid(Buffer.concat([page(opusHead(),0,2),page(opusTags(),3,0),page(Buffer.from([0xf8,0xff,0xfe]),4,4,960)]),'ogg')
 invalid(Buffer.concat([page(opusHead(),0,2),page(opusTags(),1,0),page(Buffer.from([0xfb,0x3f]),2,4,960)]),'ogg')
 invalid(Buffer.concat([page(opusHead(),0,2),page(opusTags(),1,0),page(Buffer.from([0xf8,0xff,0xfe]),2,0,960)]),'ogg')
})
test('Ogg codec metadata cannot conceal another container or a malformed comment length',()=>{
 invalid(Buffer.concat([page(Buffer.from('MZnot-codec'),0,2),page(Buffer.from('payload'),1,4)]),'ogg')
 const tags=opusTags();tags.writeUInt32LE(2000000,8);invalid(Buffer.concat([page(opusHead(),0,2),page(tags,1,0),page(Buffer.from([0xf8,0xff,0xfe]),2,4,960)]),'ogg')
})
const descriptor=(tag,payload)=>{assert.ok(payload.length<128);return Buffer.concat([Buffer.from([tag,payload.length]),payload])}
function esds(){const specific=descriptor(5,Buffer.from([0x12,0x10])),config=Buffer.alloc(13);config[0]=0x40;config[1]=0x15;config.writeUInt32BE(128000,5);config.writeUInt32BE(128000,9);return full('esds',descriptor(3,Buffer.concat([Buffer.from([0,1,0]),descriptor(4,Buffer.concat([config,specific])),descriptor(6,Buffer.from([2]))])))}
function movie({extension='mp4',external=false,encrypted=false,offsetBad=false,unreferenced=false,zeroFinalDelta=false,extraTables=[]}={}){
 const count=zeroFinalDelta?2:1,ftyp=box('ftyp',extension==='mov'?'qt  ':extension==='m4a'?'M4A ':'isom',u32(0),extension==='mov'?'qt  ':'isom'),sample=extension==='mov'?Buffer.alloc(8):Buffer.from([0x21,0x10,0x04,0x60,0x8c,0x1c]),mdat=box('mdat',...Array.from({length:count},()=>sample),...(unreferenced?[Buffer.from('MZhidden')]:[])),offset=offsetBad?4:ftyp.length+8
 const mvhd=Buffer.alloc(100);mvhd.writeUInt32BE(1000,12);mvhd.writeUInt32BE(1000,16);mvhd.writeUInt32BE(0x10000,20);mvhd.writeUInt16BE(0x100,24);mvhd.writeUInt32BE(0x10000,36);mvhd.writeUInt32BE(0x10000,52);mvhd.writeUInt32BE(0x40000000,68);mvhd.writeUInt32BE(2,96)
 const tkhd=Buffer.alloc(84);tkhd[3]=3;tkhd.writeUInt32BE(1,12);tkhd.writeUInt32BE(1000,20);tkhd.writeUInt16BE(0x100,36);tkhd.writeUInt32BE(0x10000,40);tkhd.writeUInt32BE(0x10000,56);tkhd.writeUInt32BE(0x40000000,72)
 const mdhd=Buffer.alloc(24);mdhd.writeUInt32BE(44100,12);mdhd.writeUInt32BE(1024,16)
 const hdlr=full('hdlr',Buffer.concat([u32(0),Buffer.from('soun'),Buffer.alloc(12),Buffer.from('Sound\0')]))
 const entry=Buffer.alloc(28);entry.writeUInt16BE(1,6);entry.writeUInt16BE(2,16);entry.writeUInt16BE(16,18);entry.writeUInt32BE(44100*65536,24)
 const sd=full('stsd',Buffer.concat([u32(1),box(encrypted?'enca':extension==='mov'?'sowt':'mp4a',entry,...(extension==='mov'?[]:[esds()]))]))
 const stbl=box('stbl',sd,full('stts',Buffer.concat([u32(zeroFinalDelta?2:1),u32(1),u32(1024),...(zeroFinalDelta?[u32(1),u32(0)]:[])])),full('stsc',Buffer.concat([u32(1),u32(1),u32(count),u32(1)])),full('stsz',Buffer.concat([u32(sample.length),u32(count)])),full('stco',Buffer.concat([u32(1),u32(offset)])),...extraTables)
 const dref=full('dref',Buffer.concat([u32(1),full('url ',external?Buffer.from('https://example.invalid/audio\0'):Buffer.alloc(0),0,external?0:1)]))
 const moov=box('moov',box('mvhd',mvhd),box('trak',box('tkhd',tkhd),box('mdia',box('mdhd',mdhd),hdlr,box('minf',full('smhd',Buffer.alloc(4)),box('dinf',dref),stbl))))
 return Buffer.concat([ftyp,mdat,moov])
}
test('generated AAC M4A/MP4 and PCM QuickTime have real track, codec, sample-table and data-reference structures',()=>{
 for(const extension of ['m4a','mp4','mov'])validateMedia(movie({extension}),extension)
 validateMedia(movie({zeroFinalDelta:true}),'mp4')
})
test('optional sample timing, sync and grouping tables have checked cardinalities and no encryption group',()=>{
 const ctts=full('ctts',Buffer.concat([u32(1),u32(1),u32(0)])),stss=full('stss',Buffer.concat([u32(1),u32(1)])),sgpd=full('sgpd',Buffer.concat([Buffer.from('roll'),u32(2),u32(1),Buffer.alloc(2)]),1),sbgp=full('sbgp',Buffer.concat([Buffer.from('roll'),u32(1),u32(1),u32(1)]))
 validateMedia(movie({extraTables:[ctts,stss,sgpd,sbgp]}),'mp4')
 for(const extra of [full('ctts',Buffer.concat([u32(1),u32(2),u32(0)])),full('stss',Buffer.concat([u32(1),u32(2)])),full('sbgp',Buffer.concat([Buffer.from('seig'),u32(0)]))])invalid(movie({extraTables:[extra]}),'mp4')
})
test('BMFF does not accept only ftyp/magic, truncated atoms, appended payloads or mismatched sample offsets',()=>{
 invalid(box('ftyp','isom',u32(0),'isom'),'mp4')
 const good=movie();for(const b of [good.subarray(0,-1),Buffer.concat([good,Buffer.from('MZhidden')]),movie({offsetBad:true}),movie({unreferenced:true})])invalid(b,'mp4')
 const length=Buffer.from(good);length.writeUInt32BE(0x7fffffff,0);invalid(length,'mp4')
})
test('encrypted codec entries, external data references and fragmented/active containers are refused',()=>{
 invalid(movie({external:true}),'mp4');invalid(movie({encrypted:true}),'mp4')
 for(const type of ['moof','pssh','uuid','rmra'])invalid(Buffer.concat([movie(),box(type,Buffer.alloc(8))]),'mp4')
})
test('AAC descriptor lengths, audio-specific metadata and sample tables are checked rather than searched for signatures',()=>{
 for(const target of ['esds','stts','stsc','stsz','stco']){const b=movie(),at=b.indexOf(Buffer.from(target));assert.ok(at>0);if(target==='esds')b[at+8]=0x7f;else b.writeUInt32BE(0xffffffff,at+8);invalid(b,'mp4')}
 const config=movie(),asc=config.indexOf(Buffer.from([5,2,0x12,0x10]));assert.ok(asc>0);config[asc+2]=0x17;invalid(config,'m4a')
})
const idHex=id=>Buffer.from(id.toString(16).padStart(id>0xffffff?8:id>0xffff?6:id>255?4:2,'0'),'hex')
function vint(n){for(let width=1;width<=7;width++)if(n<2**(7*width)-1){const b=Buffer.alloc(width);let value=n;for(let i=width-1;i>=0;i--){b[i]=value%256;value=Math.floor(value/256)}b[0]|=1<<(8-width);return b}throw Error('fixture too large')}
const element=(id,payload)=>Buffer.concat([idHex(id),vint(payload.length),payload])
const integer=(id,n)=>element(id,n<256?Buffer.from([n]):u32(n))
function webm({unknown=false,external=false,encrypted=false,badTrack=false,badPacket=false,lacing=false,twoClusters=false}={}){
 const header=element(0x1a45dfa3,Buffer.concat([integer(0x4286,1),integer(0x42f7,1),integer(0x42f2,4),integer(0x42f3,8),element(0x4282,Buffer.from('webm')),integer(0x4287,4),integer(0x4285,2)]))
 const frequency=Buffer.alloc(8);frequency.writeDoubleBE(48000)
 const track=element(0xae,Buffer.concat([integer(0xd7,1),integer(0x73c5,1),integer(0x83,2),element(0x86,Buffer.from('A_OPUS')),element(0x63a2,opusHead()),element(0xe1,Buffer.concat([integer(0x9f,2),element(0xb5,frequency)])),...(external?[element(0x3b4040,Buffer.from('https://example.invalid/codec'))]:[]),...(encrypted?[element(0x6d80,Buffer.alloc(0))]:[])]))
 const packet=badPacket?Buffer.from([0xfb,63]):Buffer.from([0xf8,0xff,0xfe]),block=element(0xa3,Buffer.concat([Buffer.from([badTrack?0x82:0x81,0,0,lacing?4:0]),...(lacing?[Buffer.from([1])]:[]),packet]))
 const c=Buffer.concat([integer(0xe7,0),block]),cluster=unknown?Buffer.concat([idHex(0x1f43b675),Buffer.from([1,255,255,255,255,255,255,255]),c]):element(0x1f43b675,c)
 const segment=Buffer.concat([element(0x1549a966,integer(0x2ad7b1,1000000)),element(0x1654ae6b,track),cluster,...(twoClusters?[cluster]:[])])
 return Buffer.concat([header,unknown?Buffer.concat([idHex(0x18538067),Buffer.from([1,255,255,255,255,255,255,255]),segment]):element(0x18538067,segment)])
}
test('WebM validates EBML/DocType, Opus track headers and bounded packets, including finite and live-size segments',()=>{
 validateMedia(webm(),'webm');validateMedia(webm({unknown:true}),'webm');validateMedia(webm({unknown:true,twoClusters:true}),'webm')
})
test('WebM rejects encryption, external codec URLs, missing tracks, malformed lacing and malformed Opus packet framing',()=>{
 for(const options of [{external:true},{encrypted:true},{badTrack:true},{badPacket:true},{lacing:true}])invalid(webm(options),'webm')
 const good=webm();invalid(good.subarray(0,-1),'webm');invalid(Buffer.concat([good,Buffer.from('MZappend')]),'webm')
 const doctype=Buffer.from(good),at=doctype.indexOf(Buffer.from('webm'));doctype.write('html',at);invalid(doctype,'webm')
})
test('every media extension rejects executables, HTML, empty or unsupported inputs without invoking a decoder',()=>{
 for(const ext of ['mp3','wav','m4a','ogg','mp4','webm','mov','avif'])for(const bytes of [Buffer.from('MZfake executable'),Buffer.from('\x7fELFfake'),Buffer.from('<html><script>bad()</script>'),Buffer.alloc(0)])invalid(bytes,ext)
 invalid(wav(),'exe');assert.throws(()=>avifDecodedPixelBudget(Buffer.from('not avif')),{status:422})
})

// AVIF-generated item metadata is used for negative extent/grid/budget cases;
// the positive compressed-image compatibility fixture is supplied separately
// from the official libavif test corpus, never generated by a fake decoder.
function avif(){const data=Buffer.from([0x0a,1,0,0x32,1,0]),ftyp=box('ftyp','avif',u32(0),'avif','mif1','miaf');const mdat=box('mdat',data),offset=ftyp.length+8
 const pitm=full('pitm',Buffer.from([0,1])),infe=full('infe',Buffer.concat([Buffer.from([0,1,0,0]),Buffer.from('av01'),Buffer.from([0])]),2),iinf=full('iinf',Buffer.concat([Buffer.from([0,1]),infe]))
 const iloc=full('iloc',Buffer.concat([Buffer.from([0x44,0,0,1,0,1,0,0,0,1]),u32(offset),u32(data.length)]))
 const iprp=box('iprp',box('ipco',full('ispe',Buffer.concat([u32(1),u32(1)])),box('av1C',Buffer.from([0x81,0,0,0]))),full('ipma',Buffer.from([0,0,0,1,0,1,2,0x81,0x82])))
 return Buffer.concat([ftyp,mdat,full('meta',Buffer.concat([pitm,iinf,iloc,iprp]))])
}
test('AVIF archive budget uses bounded image properties, and unsupported grids/oversized extents cannot pass',()=>{
 const b=avif();assert.equal(avifDecodedPixelBudget(b),1)
 const huge=Buffer.from(b),ispe=huge.indexOf(Buffer.from('ispe'));huge.writeUInt32BE(16384,ispe+8);huge.writeUInt32BE(16384,ispe+12);assert.throws(()=>avifDecodedPixelBudget(huge),{status:422});invalid(huge,'avif')
 const grid=Buffer.from(b);grid.write('grid',grid.indexOf(Buffer.from('av01')));invalid(grid,'avif')
 const extent=Buffer.from(b),iloc=extent.indexOf(Buffer.from('iloc'));extent.writeUInt32BE(0xffffffff,iloc+18);invalid(extent,'avif')
 const truncated=Buffer.from(b);truncated.writeUInt32BE(0xffffffff,0);invalid(truncated,'avif')
})
