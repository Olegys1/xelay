import { createAssistantCloudRuntime } from '../server/assistant-v2/cloudRuntime.ts'

// Inactive until the private draft migration is applied and the existing
// server-only environment is checked. Model routing additionally requires its
// separate approval/readiness switches and a durable private spend reservation.
export default createAssistantCloudRuntime()
