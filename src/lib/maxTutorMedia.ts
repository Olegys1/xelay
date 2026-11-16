/** Optional browser media. No recording, uploads, provider SDKs or automatic playback. */
export const MAX_TUTOR_DICTATION_CHARACTERS = 2400
export const MAX_TUTOR_NARRATION_CHARACTERS = 12000
export type TutorMediaClock = {set:(run:()=>void, milliseconds:number)=>unknown;clear:(handle:unknown)=>void}
const clock: TutorMediaClock = {set:(run,ms)=>setTimeout(run,ms),clear:handle=>clearTimeout(handle as ReturnType<typeof setTimeout>)}
export type TutorRecognitionResult = {isFinal:boolean;[index:number]:{transcript:string}}
export type TutorRecognitionEvent = {resultIndex:number;results:ArrayLike<TutorRecognitionResult>}
export type TutorRecognition = {
  lang:string;continuous:boolean;interimResults:boolean;maxAlternatives:number
  onresult:((event:TutorRecognitionEvent)=>void)|null;onend:(()=>void)|null;onerror:((event:{error?:string})=>void)|null
  start:()=>void;stop:()=>void;abort:()=>void
}
export type TutorRecognitionFactory = ()=>TutorRecognition
export type TutorDictationState = {phase:'idle'|'listening'|'stopping';transcript:string;error:string;limitReached:boolean}
export const emptyTutorDictationState = ():TutorDictationState=>({phase:'idle',transcript:'',error:'',limitReached:false})
const recognitionError = (error?:string) => error==='not-allowed'||error==='service-not-allowed'?'Браузер не дозволив доступ до мікрофона. Перевір його налаштування або введи текст вручну.':error==='audio-capture'?'Мікрофон недоступний. Можна продовжити звичайним текстом.':error==='no-speech'?'Не вдалося почути мовлення. Спробуй ще раз або введи текст.':error==='network'?'Сервіс розпізнавання браузера недоступний. Спробуй пізніше або введи текст.':'Не вдалося завершити диктування. Можна продовжити звичайним текстом.'
const cleanTranscript=(text:string)=>text.replace(/\s+/g,' ').trim()

export function createTutorDictation(options:{factory:TutorRecognitionFactory|null;onUpdate?:(state:TutorDictationState)=>void;onComplete?:(text:string)=>void;maxCharacters?:number;durationMs?:number;clock?:TutorMediaClock}){
  const timers=options.clock||clock,max=Math.max(1,Math.min(MAX_TUTOR_DICTATION_CHARACTERS,Math.floor(options.maxCharacters||MAX_TUTOR_DICTATION_CHARACTERS)))
  const duration=Math.max(1000,Math.min(120000,options.durationMs||60000))
  let state=emptyTutorDictationState(),recognition:TutorRecognition|null=null,disposed=false,epoch=0,durationTimer:unknown=null,finishTimer:unknown=null
  let segments=new Map<number,{text:string;final:boolean}>()
  const publish=()=>{if(!disposed)options.onUpdate?.({...state})}
  const clearTimers=()=>{if(durationTimer!==null)timers.clear(durationTimer);if(finishTimer!==null)timers.clear(finishTimer);durationTimer=null;finishTimer=null}
  function detach(){if(recognition){recognition.onresult=null;recognition.onend=null;recognition.onerror=null}}
  function finish(error=''){
    if(disposed||state.phase==='idle')return
    const text=cleanTranscript([...segments.values()].filter(part=>part.final).map(part=>part.text).join(' ')).slice(0,max)
    const old=recognition;clearTimers();detach();recognition=null;epoch++;try{old?.abort()}catch{}
    state={...state,phase:'idle',transcript:text,error:error||(!text?'Не розпізнано завершеного тексту. Спробуй ще раз або введи повідомлення.':'')};publish()
    if(text)options.onComplete?.(text)
  }
  function stop(){
    if(disposed||!recognition||state.phase!=='listening')return
    state={...state,phase:'stopping'};publish()
    const token=epoch
    finishTimer=timers.set(()=>{if(token===epoch)finish()},2000)
    try{recognition.stop()}catch{finish()}
  }
  function cancel(){
    const old=recognition;epoch++;clearTimers();detach();recognition=null;segments.clear();state=emptyTutorDictationState()
    try{old?.abort()}catch{ /* A browser may already have ended the input. */ }
    publish()
  }
  return {
    getState:()=>({...state}),
    start(consent:boolean){
      if(disposed||state.phase!=='idle')return false
      if(!consent){state={...state,error:'Спочатку дозволь розпізнавання голосу браузером.'};publish();return false}
      if(!options.factory){state={...state,error:'У цьому браузері диктування недоступне. Введи текст вручну.'};publish();return false}
      epoch++;const token=epoch;segments=new Map();state={...emptyTutorDictationState(),phase:'listening'}
      try{
        recognition=options.factory();recognition.lang='uk-UA';recognition.continuous=true;recognition.interimResults=true;recognition.maxAlternatives=1
        recognition.onresult=event=>{
          if(disposed||token!==epoch||state.phase==='idle')return
          const length=Math.min(200,Math.max(0,event.results.length)),from=Math.max(0,Math.min(length,event.resultIndex||0))
          for(let index=from;index<length;index++){const row=event.results[index],text=row?.[0]?.transcript;if(typeof text==='string')segments.set(index,{text:cleanTranscript(text.slice(0,max)),final:row.isFinal===true})}
          const transcript=cleanTranscript([...segments.values()].map(part=>part.text).join(' ')),limitReached=transcript.length>=max
          state={...state,transcript:transcript.slice(0,max),limitReached};publish()
          if(limitReached)stop()
        }
        recognition.onend=()=>{if(token===epoch)finish()}
        recognition.onerror=event=>{if(token===epoch)finish(event.error==='aborted'?'':recognitionError(event.error))}
        publish();recognition.start()
        if(token===epoch&&state.phase!=='idle')durationTimer=timers.set(()=>{if(token===epoch)stop()},duration)
        return true
      }catch{finish('Не вдалося ввімкнути мікрофон. Перевір дозвіл браузера або введи текст.');return false}
    },
    stop,cancel,
    dispose(){disposed=true;cancel()},
  }
}

export type TutorBrowserVoice={voiceURI:string;name:string;lang:string;localService?:boolean;default?:boolean}
export type TutorUtterance={text:string;lang:string;voice:TutorBrowserVoice|null;rate:number;onend:(()=>void)|null;onerror:((event:{error?:string})=>void)|null}
export type TutorSpeechSynthesis={speak:(utterance:TutorUtterance)=>void;cancel:()=>void;pause:()=>void;resume:()=>void;getVoices:()=>TutorBrowserVoice[];addEventListener?:(type:string,listener:()=>void)=>void;removeEventListener?:(type:string,listener:()=>void)=>void}
export type TutorSpeechFactory={synthesis:TutorSpeechSynthesis;utterance:(text:string)=>TutorUtterance}
export type TutorNarrationState={phase:'idle'|'speaking'|'paused'|'error';chunk:number;total:number;error:string}
export const emptyTutorNarrationState=():TutorNarrationState=>({phase:'idle',chunk:0,total:0,error:''})

/** Short utterances avoid long-text browser cutoffs. The full bounded text stays available. */
export function prepareTutorNarration(value:string):string[]{
  if(typeof value!=='string')throw Error('Немає тексту для озвучення.')
  let text=value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim()
  if(!text)throw Error('Спочатку отримай текстову відповідь.')
  if(text.length>MAX_TUTOR_NARRATION_CHARACTERS)throw Error('Цей текст завеликий для озвучення браузером. Обери коротший фрагмент до 12 000 символів.')
  const chunks:string[]=[]
  while(text.length){
    let cut=Math.min(420,text.length)
    if(cut<text.length){const prefix=text.slice(0,cut),sentence=Math.max(prefix.lastIndexOf('. '),prefix.lastIndexOf('? '),prefix.lastIndexOf('! '),prefix.lastIndexOf('\n'));const word=prefix.lastIndexOf(' ');if(sentence>160)cut=sentence+1;else if(word>160)cut=word}
    const part=text.slice(0,cut).trim();if(part)chunks.push(part);text=text.slice(cut).trimStart()
  }
  return chunks
}
const activeNarration=new WeakMap<object,{owner:symbol;stop:()=>void}>()
export function createTutorNarrator(options:{speech:TutorSpeechFactory|null;onUpdate?:(state:TutorNarrationState)=>void}){
  const owner=Symbol('xelay-browser-narration');let disposed=false,epoch=0,state=emptyTutorNarrationState(),utterance:TutorUtterance|null=null,chunks:string[]=[],voice:TutorBrowserVoice|null=null
  const publish=()=>{if(!disposed)options.onUpdate?.({...state})}
  const owns=()=>!!options.speech&&activeNarration.get(options.speech.synthesis)?.owner===owner
  function detach(){if(utterance){utterance.onend=null;utterance.onerror=null}utterance=null}
  function release(){if(options.speech&&owns())activeNarration.delete(options.speech.synthesis)}
  function stop(){epoch++;detach();if(options.speech&&owns()){release();try{options.speech.synthesis.cancel()}catch{}}chunks=[];state=emptyTutorNarrationState();publish()}
  function fail(){detach();if(options.speech&&owns()){release();try{options.speech.synthesis.cancel()}catch{}}state={...state,phase:'error',error:'Браузер не зміг озвучити текст. Текстова відповідь залишається доступною.'};publish()}
  function speak(index:number,token:number){
    if(disposed||token!==epoch||!options.speech||!owns())return
    if(index>=chunks.length){detach();release();state={...state,phase:'idle',chunk:chunks.length};publish();return}
    try{
      utterance=options.speech.utterance(chunks[index]);utterance.lang=voice?.lang||'uk-UA';utterance.voice=voice;utterance.rate=1
      utterance.onend=()=>{if(disposed||token!==epoch||!owns())return;detach();speak(index+1,token)}
      utterance.onerror=()=>{if(!disposed&&token===epoch&&owns())fail()}
      state={phase:'speaking',chunk:index+1,total:chunks.length,error:''};publish();options.speech.synthesis.speak(utterance)
    }catch{fail()}
  }
  return {
    getState:()=>({...state}),
    play(text:string,selectedVoice:TutorBrowserVoice|null=null,userInitiated=false){
      if(disposed||!userInitiated)return false
      stop()
      if(!options.speech){state={...state,phase:'error',error:'Цей браузер не підтримує озвучення. Прочитай текстову відповідь.'};publish();return false}
      try{chunks=prepareTutorNarration(text)}catch(error){state={...state,phase:'error',error:error instanceof Error?error.message:'Не вдалося підготувати озвучення.'};publish();return false}
      activeNarration.get(options.speech.synthesis)?.stop();voice=selectedVoice;activeNarration.set(options.speech.synthesis,{owner,stop});speak(0,++epoch);return state.phase!=='error'
    },
    pause(){if(disposed||state.phase!=='speaking'||!owns())return;try{options.speech!.synthesis.pause();state={...state,phase:'paused'};publish()}catch{fail()}},
    resume(){if(disposed||state.phase!=='paused'||!owns())return;try{options.speech!.synthesis.resume();state={...state,phase:'speaking'};publish()}catch{fail()}},
    stop,
    dispose(){disposed=true;stop()},
  }
}

/** Detection reads API availability only: no constructors, microphone or playback are started. */
export function getTutorBrowserMedia(host:unknown=typeof window==='undefined'?null:window):{dictation:TutorRecognitionFactory|null;speech:TutorSpeechFactory|null}{
  if(!host||typeof host!=='object')return{dictation:null,speech:null}
  try{
    const browser=host as {SpeechRecognition?:new()=>TutorRecognition;webkitSpeechRecognition?:new()=>TutorRecognition;speechSynthesis?:TutorSpeechSynthesis;SpeechSynthesisUtterance?:new(text:string)=>TutorUtterance}
    const Recognition=browser.SpeechRecognition||browser.webkitSpeechRecognition,Synthesis=browser.SpeechSynthesisUtterance,synthesis=browser.speechSynthesis
    return{dictation:typeof Recognition==='function'?()=>new Recognition():null,speech:synthesis&&typeof synthesis.speak==='function'&&typeof synthesis.cancel==='function'&&typeof synthesis.pause==='function'&&typeof synthesis.resume==='function'&&typeof synthesis.getVoices==='function'&&typeof Synthesis==='function'?{synthesis,utterance:text=>new Synthesis(text)}:null}
  }catch{return{dictation:null,speech:null}}
}
