// GIF87a/89a framing and bounded LZW validation; never renders an image.
// Specification: https://www.w3.org/Graphics/GIF/spec-gif89a.txt
export class UploadAdditionalImageValidationError extends Error {
  readonly status = 422
  readonly statusCode = 422
  constructor(readonly code: string, message: string) { super(message); this.name = 'UploadAdditionalImageValidationError' }
}
function bad(code = 'UPLOAD_IMAGE_INVALID', message = 'GIF пошкоджений або містить непідтримувані блоки. Збережіть його заново як GIF, PNG чи JPG.'): never { throw new UploadAdditionalImageValidationError(code,message) }
function bound(value: unknown): asserts value { if(!value)bad('UPLOAD_IMAGE_LIMIT','GIF має надто великі розміри або забагато кадрів. Зменште його чи додайте посилання.') }
function lzw(data:Buffer,minimum:number,expected:number,palette:number) {
  if(minimum<2||minimum>8||!data.length)bad()
  const clear=1<<minimum,end=clear+1,lengths=new Uint32Array(4096)
  for(let i=0;i<clear;i++)lengths[i]=i<palette?1:0
  let width=minimum+1,next=end+1,previous=-1,bit=0,decoded=0,first=true,ended=false
  while(bit+width<=data.length*8){
    let code=0;for(let i=0;i<width;i++)code|=((data[(bit+i)>>>3]>>>((bit+i)&7))&1)<<i;bit+=width
    if(first&&code!==clear)bad();first=false
    if(code===clear){width=minimum+1;next=end+1;previous=-1;continue}
    if(code===end){ended=true;break}
    const size=code<next?lengths[code]:code===next&&previous>=0?lengths[previous]+1:0
    if(!size||code>=4096||decoded+size>expected)bad()
    decoded+=size
    if(previous>=0&&next<4096){lengths[next++]=lengths[previous]+1;if(next===(1<<width)&&width<12)width++}
    previous=code
  }
  if(!ended||decoded!==expected||Math.ceil(bit/8)!==data.length)bad()
}
function inspect(bytes:Buffer,decode:boolean):number {
  bound(Buffer.isBuffer(bytes)&&bytes.length>=35&&bytes.length<=50*1024*1024)
  const version=bytes.toString('ascii',0,6)
  if(version!=='GIF87a'&&version!=='GIF89a')bad()
  const canvasWidth=bytes.readUInt16LE(6),canvasHeight=bytes.readUInt16LE(8),packed=bytes[10]
  bound(canvasWidth>0&&canvasHeight>0&&canvasWidth*canvasHeight<=32_000_000)
  const globalColors=packed&128?1<<((packed&7)+1):0
  if(globalColors&&bytes[11]>=globalColors)bad()
  let at=13+globalColors*3,frames=0,blocks=0,pixels=0,transparent=-1,pendingControl=false
  if(at>bytes.length)bad()
  function subBlocks(collect:boolean){
    const pieces:Buffer[]=[];let total=0
    for(;;){bound(++blocks<=262144);if(at>=bytes.length)bad();const size=bytes[at++];if(!size)break;if(at+size>bytes.length)bad();if(collect)pieces.push(bytes.subarray(at,at+size));total+=size;at+=size}
    return collect?Buffer.concat(pieces,total):Buffer.alloc(0)
  }
  while(at<bytes.length){
    bound(++blocks<=262144);const type=bytes[at++]
    if(type===0x3b){if(at!==bytes.length||!frames||pendingControl)bad();return pixels}
    if(type===0x21){
      if(version!=='GIF89a'||at>=bytes.length)bad()
      const label=bytes[at++]
      if(label===0xf9){
        if(pendingControl||at+6>bytes.length||bytes[at]!==4||bytes[at+5]!==0)bad()
        const flags=bytes[at+1];if(flags&0xe0||((flags>>>2)&7)>3)bad()
        transparent=flags&1?bytes[at+4]:-1;pendingControl=true;at+=6
      }else if(label===0xfe)subBlocks(false)
      else if(label===0xff){
        if(at+17>bytes.length||bytes[at++]!==11)bad()
        const application=bytes.toString('ascii',at,at+11);at+=11
        if(!['NETSCAPE2.0','ANIMEXTS1.0'].includes(application)||bytes[at]!==3||bytes[at+1]!==1||bytes[at+4]!==0)bad()
        at+=5
      }else bad('UPLOAD_IMAGE_UNSUPPORTED','GIF містить непідтримуване розширення. Перезбережіть зображення як звичайний GIF, PNG чи JPG.')
      continue
    }
    if(type!==0x2c||at+9>bytes.length)bad()
    const x=bytes.readUInt16LE(at),y=bytes.readUInt16LE(at+2),w=bytes.readUInt16LE(at+4),h=bytes.readUInt16LE(at+6),flags=bytes[at+8];at+=9
    bound(++frames<=1024&&w>0&&h>0&&x+w<=canvasWidth&&y+h<=canvasHeight&&pixels+w*h<=64*1024*1024)
    if(flags&0x18)bad()
    const colors=flags&128?1<<((flags&7)+1):globalColors
    if(!colors||transparent>=colors)bad()
    if(flags&128)at+=colors*3
    if(at>=bytes.length)bad()
    const minimum=bytes[at++];if(minimum<2||minimum>8)bad()
    const data=subBlocks(decode);if(decode)lzw(data,minimum,w*h,colors)
    pixels+=w*h;transparent=-1;pendingControl=false
  }
  return bad()
}
/** Cheap structural frame inventory for a ZIP's combined decoding budget. */
export function gifDecodedPixelBudget(bytes:Buffer):number{return inspect(bytes,false)}
export function validateGif(bytes:Buffer):void{inspect(bytes,true)}
