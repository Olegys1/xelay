import {createStudentLearningLibrary} from '../server/student-learning/studentLearningLibrary.js'
export const config={maxDuration:30}
const handler=createStudentLearningLibrary()
export default handler
