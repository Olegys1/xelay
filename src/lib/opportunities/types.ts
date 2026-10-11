export type WorkspaceRole = 'student' | 'company' | 'admin'
export type OpportunityKind = 'job' | 'internship' | 'course' | 'event' | 'scholarship' | 'offer'
export type ReviewStatus = 'draft' | 'pending' | 'approved' | 'changes' | 'rejected' | 'paused' | 'closed'
export type ApplicationStatus = 'sent' | 'reviewing' | 'invited' | 'completed' | 'withdrawn'
export type Placement = 'catalog' | 'home' | 'news' | 'entry'
export interface WorkspaceActor { id: string; name: string; role: WorkspaceRole; companyIds: string[]; premium: boolean }
export interface CareerFile { id: string; name: string; size: number; mime: string; path: string; ownerId: string; kind: 'resume' | 'company' | 'opportunity' }
export interface Company {
  id: string; revision: number; ownerId: string; name: string; tagline: string; description: string; industry: string;
  city: string; website: string; contactEmail: string; contactName: string; legalName: string; registrationCode: string;
  logo: string; color: string; status: ReviewStatus; partner: boolean; reviewNote: string; createdAt: string;
}
export interface Opportunity {
  id: string; revision: number; companyId: string; kind: OpportunityKind; title: string; summary: string; description: string;
  requirements: string; benefits: string; city: string; format: 'remote' | 'office' | 'hybrid'; employment: string;
  experience: string; compensation: string; paid: 'yes' | 'no' | 'unspecified'; direction: string;
  deadline: string; startsAt: string; applicationMode: 'internal' | 'external'; externalUrl: string;
  status: ReviewStatus; reviewNote: string; files: CareerFile[]; createdAt: string;
}
export interface CareerResume {
  id: string; ownerId: string; fullName: string; headline: string; about: string; education: string;
  skills: string[]; languages: string; experience: string; projects: string; city: string;
  format: string; availability: string; salary: string; portfolioUrl: string; contact: string;
  seeking: OpportunityKind[]; visibility: 'private' | 'employers'; file: CareerFile | null;
  version: number; updatedAt: string;
}
export interface ApplicationMessage { id: string; authorId: string; authorName: string; body: string; createdAt: string }
export interface CareerApplication {
  id: string; opportunityId: string; companyId: string; studentId: string; studentName: string;
  message: string; contact: string; resumeSnapshot: CareerResume; status: ApplicationStatus;
  messages: ApplicationMessage[]; createdAt: string; updatedAt: string;
}
export interface Campaign {
  id: string; revision: number; companyId: string; opportunityId: string; title: string; body: string; image: string;
  cta: string; url: string; placements: Placement[]; universities: string[]; faculties: string[];
  years: number[]; directions: string[]; startsAt: string; endsAt: string; status: ReviewStatus;
  reviewNote: string; frequencyDays: number; createdAt: string;
}
export interface PlacementOrder {
  id: string; campaignId: string; companyId: string; label: string; amount: number; currency: 'UAH';
  status: 'draft' | 'awaiting_payment' | 'paid' | 'cancelled' | 'refunded'; paymentMethod: 'invoice' | 'wayforpay';
  reference: string; terms: string; startsAt: string; endsAt: string; createdAt: string; paidAt: string | null;
}
export interface CampaignEvent { id: string; campaignId: string; actorId: string; type: 'impression' | 'click' | 'save' | 'hide'; placement: Placement; createdAt: string }
export interface CampaignMetrics {
  campaignId: string; impressions: number | null; clicks: number | null; saves: number | null;
  hides: number | null; reach: number | null; applications: number | null; suppressed: boolean;
}
export interface CompanyMembership { id: string; companyId: string; userId: string; email: string; role: 'owner' | 'editor' | 'recruiter'; status: 'pending' | 'accepted' | 'revoked' }
export interface CareerReport { id: string; actorId: string; opportunityId: string; reason: string; status: 'open' | 'resolved'; createdAt: string }
export interface WorkspaceNotification { id: string; userId: string; title: string; body: string; read: boolean; createdAt: string }
export interface WorkspaceAudit { id: string; actorId: string; action: string; entityId: string; note: string; createdAt: string }
export interface WorkspaceSettings { enabled: boolean; advertisingEnabled: boolean; entryEnabled: boolean; entryFrequencyDays: number; promotedEvery: number; minimumSegmentSize: number }
export interface CareerPreferences { digest: boolean; directions: string[]; hiddenCompanyIds: string[]; lastEntryAt: string | null }
export interface WorkspaceSnapshot {
  actor: WorkspaceActor; companies: Company[]; opportunities: Opportunity[]; resume: CareerResume | null;
  candidateResumes: CareerResume[]; applications: CareerApplication[]; savedIds: string[]; hiddenIds: string[];
  campaigns: Campaign[]; orders: PlacementOrder[]; events: CampaignEvent[]; metrics?: CampaignMetrics[]; members: CompanyMembership[];
  reports: CareerReport[]; notifications: WorkspaceNotification[]; audit: WorkspaceAudit[];
  settings: WorkspaceSettings; preferences: CareerPreferences;
}
export type WorkspaceCommand =
  | { type: 'resume.save'; resume: CareerResume }
  | { type: 'company.save'; company: Company }
  | { type: 'company.submit'; id: string }
  | { type: 'company.review'; id: string; expectedRevision: number; status: 'approved' | 'changes' | 'rejected'; note: string; partner?: boolean }
  | { type: 'company.invite'; companyId: string; email: string; role: 'editor' | 'recruiter' }
  | { type: 'company.member'; id: string; status: 'accepted' | 'revoked' }
  | { type: 'opportunity.save'; opportunity: Opportunity }
  | { type: 'opportunity.submit'; id: string }
  | { type: 'opportunity.review'; id: string; expectedRevision: number; status: 'approved' | 'changes' | 'rejected' | 'paused' | 'closed'; note: string }
  | { type: 'saved.toggle'; id: string }
  | { type: 'hidden.toggle'; id: string }
  | { type: 'application.submit'; opportunityId: string; message: string; contact: string; consent: boolean }
  | { type: 'application.status'; id: string; status: ApplicationStatus }
  | { type: 'application.message'; id: string; body: string }
  | { type: 'report.submit'; opportunityId: string; reason: string }
  | { type: 'report.resolve'; id: string }
  | { type: 'campaign.save'; campaign: Campaign }
  | { type: 'campaign.submit'; id: string }
  | { type: 'campaign.review'; id: string; expectedRevision: number; status: 'approved' | 'changes' | 'rejected' | 'paused' | 'closed'; note: string }
  | { type: 'order.save'; order: PlacementOrder }
  | { type: 'order.status'; id: string; status: PlacementOrder['status']; reference: string }
  | { type: 'event.record'; campaignId: string; event: CampaignEvent['type']; placement: Placement }
  | { type: 'entry.reserve'; campaignId: string }
  | { type: 'notification.read'; id: string }
  | { type: 'preferences.save'; preferences: CareerPreferences }
  | { type: 'settings.save'; settings: WorkspaceSettings }

export interface OpportunitiesRepository {
  readonly mode: 'local' | 'supabase';
  load(): Promise<WorkspaceSnapshot>;
  execute(command: WorkspaceCommand): Promise<WorkspaceSnapshot>;
  upload(file: File, kind: CareerFile['kind']): Promise<CareerFile>;
  fileUrl(file: CareerFile): Promise<string>;
}

export const KIND_LABELS: Record<OpportunityKind, string> = { job: 'Робота', internship: 'Стажування', course: 'Навчання', event: 'Подія', scholarship: 'Конкурс / стипендія', offer: 'Для студентів' }
export const REVIEW_LABELS: Record<ReviewStatus, string> = { draft: 'Чернетка', pending: 'На перевірці', approved: 'Схвалено', changes: 'Потрібні зміни', rejected: 'Відхилено', paused: 'Призупинено', closed: 'Завершено' }
export const APPLICATION_LABELS: Record<ApplicationStatus, string> = { sent: 'Надіслано', reviewing: 'На розгляді', invited: 'Запрошення', completed: 'Завершено', withdrawn: 'Відкликано' }
export const PLACEMENT_LABELS: Record<Placement, string> = { catalog: 'Каталог', home: 'Головна', news: 'Новини', entry: 'При відкритті' }
export const ORDER_LABELS: Record<PlacementOrder['status'], string> = { draft: 'Чернетка', awaiting_payment: 'Очікує оплати', paid: 'Оплачено', cancelled: 'Скасовано', refunded: 'Повернено' }
export const DEFAULT_SETTINGS: WorkspaceSettings = { enabled: false, advertisingEnabled: false, entryEnabled: false, entryFrequencyDays: 7, promotedEvery: 8, minimumSegmentSize: 30 }
export const newEntityId = () => crypto.randomUUID()
export function emptyResume(actor: WorkspaceActor): CareerResume {
  return { id: newEntityId(), ownerId: actor.id, fullName: actor.name, headline: '', about: '', education: '', skills: [], languages: '', experience: '', projects: '', city: '', format: 'Будь-який', availability: '', salary: '', portfolioUrl: '', contact: '', seeking: ['internship'], visibility: 'private', file: null, version: 0, updatedAt: new Date().toISOString() }
}
