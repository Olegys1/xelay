import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {validateGif,gifDecodedPixelBudget,UploadAdditionalImageValidationError} from '../../server/uploadAdditionalImageValidation.ts'
function bits(codes,width=3){let value=0,n=0;const bytes=[];for(const code of codes){value|=code<<n;n+=width;while(n>=8){bytes.push(value&255);value>>>=8;n-=8}}if(n)bytes.push(value&255);return Buffer.from(bytes)}
function fixture({width=2,height=2,frames=1,loop=false,version='GIF89a',codes}={}){
  const header=Buffer.alloc(13);header.write(version);header.writeUInt16LE(width,6);header.writeUInt16LE(height,8);header[10]=0x80
  const parts=[header,Buffer.from([0,0,0,255,255,255])]
  if(loop)parts.push(Buffer.from([0x21,0xff,11]),Buffer.from('NETSCAPE2.0'),Buffer.from([3,1,0,0,0]))
  for(let f=0;f<frames;f++){
    if(version==='GIF89a')parts.push(Buffer.from([0x21,0xf9,4,0,10,0,0,0]))
    const descriptor=Buffer.alloc(10);descriptor[0]=0x2c;descriptor.writeUInt16LE(width,5);descriptor.writeUInt16LE(height,7)
    const data=bits(codes||[...Array.from({length:width*height},()=>[4,f&1]).flat(),5]);assert.ok(data.length<256)
    parts.push(descriptor,Buffer.from([2,data.length]),data,Buffer.from([0]))
  }
  parts.push(Buffer.from([0x3b]));return Buffer.concat(parts)
}
const denies=data=>assert.throws(()=>validateGif(data),error=>error instanceof UploadAdditionalImageValidationError&&error.status===422)
test('ordinary static GIF87a and GIF89a validate their actual LZW pixels',()=>{for(const version of ['GIF87a','GIF89a']){const data=fixture({version});validateGif(data);assert.equal(gifDecodedPixelBudget(data),4)}})
test('an independent encoder image exercises real palette data and growing LZW code widths',()=>{const data=readFileSync(new URL('./fixtures/uploads/generated-palette.gif',import.meta.url));validateGif(data);assert.equal(gifDecodedPixelBudget(data),48*48)})
test('bounded standard looping GIF validates every animation frame',()=>{const data=fixture({frames:3,loop:true});validateGif(data);assert.equal(gifDecodedPixelBudget(data),12)})
test('truncated blocks, missing trailer, executable tails and fake magic never pass',()=>{const data=fixture();for(const n of [0,6,13,data.length-1,data.length-3])denies(data.subarray(0,n));denies(Buffer.concat([data,Buffer.from('MZfake')]));denies(Buffer.from('GIF89a not a real image'))})
test('LZW stream needs an end code and exactly the declared number of valid palette pixels',()=>{for(const codes of [[4,0,5],[4,0,4,0,4,0,4,0],[4,0,4,0,4,0,4,2,5],[4,0,4,0,4,0,4,0,4,0,5]])denies(fixture({codes}))})
test('canvas and cumulative animation limits reject decompression bombs without rendering',()=>{const huge=fixture();huge.writeUInt16LE(65535,6);huge.writeUInt16LE(65535,8);denies(huge);const outside=fixture();const i=outside.indexOf(Buffer.from([0x2c]));outside.writeUInt16LE(65535,i+5);denies(outside)})
test('opaque application, plain text and malformed graphics control extensions are rejected',()=>{for(const block of [Buffer.from([0x21,1,0]),Buffer.concat([Buffer.from([0x21,0xff,11]),Buffer.from('UNKNOWNAPP1'),Buffer.from([3,1,0,0,0])]),Buffer.from([0x21,0xf9,4,0xff,0,0,0,0])]){const d=fixture({version:'GIF87a'});d.write('GIF89a');denies(Buffer.concat([d.subarray(0,19),block,d.subarray(19)]))}})
