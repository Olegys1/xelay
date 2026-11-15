import { collectPartnerClick } from '../../server/partnerTools.js'

export const config = { maxDuration: 10 }
export default async function handler(req: any, res: any) {
  return collectPartnerClick(req, res)
}
