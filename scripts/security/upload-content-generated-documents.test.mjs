import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile}from'node:fs/promises'
import vm from'node:vm'
import ts from'typescript'
import * as XLSX from'xlsx'
import * as zlib from'node:zlib'
import * as crypto from'node:crypto'
import * as path from'node:path'
const source=await readFile(new URL('../../server/uploadContentValidation.ts',import.meta.url),'utf8')
const module={exports:{}}
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
 module,exports:module.exports,Buffer,Uint8Array,TextDecoder,Error,require(name){
  if(name==='node:crypto')return crypto;if(name==='node:zlib')return zlib;if(name==='node:path')return path;throw Error(name)
 }
})
const validate=module.exports.validateUploadContent
test('ordinary workbook produced by the installed spreadsheet library passes real content validation',async()=>{
 const workbook=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([['Предмет','Бал'],['Математика',5],['Економіка',4]])
 XLSX.utils.book_append_sheet(workbook,sheet,'Мої бали')
 const bytes=XLSX.write(workbook,{bookType:'xlsx',type:'buffer',compression:true})
 const result=await validate(bytes,'xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
 assert.equal(result.extension,'xlsx');assert.equal(result.size,bytes.length)
})

