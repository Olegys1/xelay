import {createMaxTutorProduction} from '../server/student-learning/maxTutorProduction.js'

export const config={maxDuration:120}
const handler=createMaxTutorProduction()
export default handler
