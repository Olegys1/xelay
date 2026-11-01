// Real bounded validators, with an explicit import inventory for the VM tests.
// The endpoint's mocked transport never substitutes content-validation results.
import * as legacy from '../../server/uploadLegacyOfficeValidation.ts'
import * as media from '../../server/uploadMediaValidation.ts'
import * as archive from '../../server/uploadArchiveValidation.ts'
import * as additionalImages from '../../server/uploadAdditionalImageValidation.ts'
export const uploadValidatorDependencies = Object.freeze({
  './uploadLegacyOfficeValidation.ts': legacy,
  './uploadMediaValidation.ts': media,
  './uploadArchiveValidation.ts': archive,
  './uploadAdditionalImageValidation.ts': additionalImages,
})
