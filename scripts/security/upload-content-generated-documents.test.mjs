import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile}from'node:fs/promises'
import vm from'node:vm'
import ts from'typescript'
import * as XLSX from'xlsx'
import * as zlib from'node:zlib'
import * as crypto from'node:crypto'
import * as path from'node:path'
import {uploadValidatorDependencies} from './upload-content-validator-dependencies.mjs'
const source=await readFile(new URL('../../server/uploadContentValidation.ts',import.meta.url),'utf8')
const module={exports:{}}
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
 module,exports:module.exports,Buffer,Uint8Array,TextDecoder,Error,require(name){
  if(name==='node:crypto')return crypto;if(name==='node:zlib')return zlib;if(name==='node:path')return path;if(Object.hasOwn(uploadValidatorDependencies,name))return uploadValidatorDependencies[name];throw Error(name)
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
test('ordinary legacy XLS workbook also passes the main dispatcher and keeps canonical MIME and hash',async()=>{
 const workbook=XLSX.utils.book_new()
 XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([['Предмет','Бал'],['Математика',5]]),'Бали')
 const bytes=XLSX.write(workbook,{bookType:'biff8',type:'buffer'})
 const result=await validate(bytes,'xls','application/vnd.ms-excel')
 assert.equal(result.extension,'xls');assert.equal(result.mime,'application/vnd.ms-excel');assert.equal(result.size,bytes.length)
 assert.equal(result.sha256,crypto.createHash('sha256').update(bytes).digest('hex'))
 await assert.rejects(validate(bytes,'doc','application/msword'),error=>error.status===422)
 await assert.rejects(validate(bytes,'xls','application/pdf'),error=>error.status===422)
})

