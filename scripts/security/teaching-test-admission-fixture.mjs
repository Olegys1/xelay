import {courseModulesFixture,readCourseModuleMigration} from './teaching-course-modules-fixture.mjs'
export async function teachingTestAdmissionFixture({applyAdmission=true}={}) {
  const fx=await courseModulesFixture()
  try {
    if(applyAdmission) await fx.db.exec(await readCourseModuleMigration('202611040060_teaching_test_admission.sql'))
    const testMutate=(who,action,payload)=>fx.rpc(who,'xelay_teaching_test_mutate',[action,JSON.stringify({expected_user_id:who,...payload})])
    return {...fx,testMutate,testDetail:(who,id)=>fx.rpc(who,'xelay_teaching_test',[id]),
      testList:(who,course=null,group=null)=>fx.rpc(who,'xelay_teaching_tests',[course,group])}
  } catch(error) {await fx.close();throw error}
}
