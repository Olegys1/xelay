import {readFile} from 'node:fs/promises'
const source=await readFile(new URL('../../requirements.txt',import.meta.url),'utf8')
const dependencies=[...source.matchAll(/^([a-zA-Z0-9_-]+)==([0-9][a-zA-Z0-9.+-]*)\s*\\/gm)]
if(dependencies.length!==10||source.includes('http:')||source.includes('https:'))throw Error('Python lockfile invalid')
for(const [,name,version] of dependencies){
 const response=await fetch(`https://pypi.org/pypi/${name}/${version}/json`,{signal:AbortSignal.timeout(30000)})
 if(!response.ok)throw Error('Python advisory service unavailable')
 const data=await response.json()
 if(data.info?.version!==version||!Array.isArray(data.vulnerabilities)||data.vulnerabilities.length)throw Error(`Python dependency requires review: ${name}`)
}
console.log('All 10 pinned Python dependencies have no advisories reported by PyPI.')
