/** Only an immersive guide mounted in its own footer may inspect its portaled
 * study navigation and footer slots. Profile/global-header controls stay outside. */
export function studentGuideOwnedRoots(guideId:string,block:HTMLElement|null,launcher:HTMLElement|null):HTMLElement[]{
 if(!block)return []
 const roots=[block]
 if(!['max','assistant'].includes(guideId)||!launcher)return roots
 const workspace=block.closest<HTMLElement>('.slp.slp-immersive')
 if(!workspace||!workspace.contains(block))return roots
 const controls=launcher.closest<HTMLElement>('#xelay-learning-controls, .slp-local-controls')
 if(!controls)return roots
 const header=controls.closest<HTMLElement>('header[data-learning-immersive="true"]'),local=controls.closest<HTMLElement>('.slp-local-rail')
 const rail=header||(local&&workspace.contains(local)?local:null)
 if(!rail)return roots
 // An exact existing footer and navigation slot are required; no global fallback.
 const controlSlot=rail.querySelector<HTMLElement>(header?'#xelay-learning-controls':'.slp-local-controls')
 if(controlSlot!==controls||!controls.contains(launcher))return roots
 const selectors=header?['#xelay-learning-navigation','#xelay-learning-controls','#xelay-learning-quota']:['.slp-local-navigation-target','.slp-local-controls','.slp-local-quota']
 for(const selector of selectors){const node=rail.querySelector<HTMLElement>(selector);if(node&&rail.contains(node)&&!roots.includes(node))roots.push(node)}
 return roots
}
