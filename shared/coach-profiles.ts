import { LIMITS, type CoachJob, type CoachProfile } from './contracts'

export interface NormalizedProfileFields {
  name: string
  details: string
  resumeText: string
}

export interface NormalizedJobFields {
  name: string
  jobDescription: string
  companyName: string
  companyWebsite: string
  companySocial: string
}

/** Rebase a delayed research result onto the current jobs, never its old snapshot. */
export function applyCompanyBrief(jobs: CoachJob[], researched: CoachJob, companyBrief: string): CoachJob[] {
  const current = jobs.find(job => job.id === researched.id)
  if (!current) throw new Error('That job was deleted while company research was running.')
  if (current.companyName !== researched.companyName || current.companyWebsite !== researched.companyWebsite || current.companySocial !== researched.companySocial) {
    throw new Error('Company details changed during research. Analyze the updated company again.')
  }
  return jobs.map(job => job.id === current.id ? { ...job, companyBrief } : job)
}

/** Cleans free text while preserving internal newlines. */
export function cleanProfileText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\u0000/g, '').trim().slice(0, max) : ''
}

function cleanSingleLine(value: unknown, max: number): string {
  return cleanProfileText(value, max).replace(/[\r\n]+/g, ' ')
}

export function normalizeProfileFields(input: unknown): NormalizedProfileFields {
  if (!input || typeof input !== 'object') throw new Error('Invalid profile data.')
  const record = input as Record<string, unknown>
  const name = cleanSingleLine(record.name, LIMITS.profileNameChars)
  if (!name) throw new Error('Give the profile a name.')
  return {
    name,
    details: cleanProfileText(record.details, LIMITS.profileDetailsChars),
    resumeText: cleanProfileText(record.resumeText, LIMITS.resumeTextChars)
  }
}

export function normalizeJobFields(input: unknown): NormalizedJobFields {
  if (!input || typeof input !== 'object') throw new Error('Invalid job data.')
  const record = input as Record<string, unknown>
  const name = cleanSingleLine(record.name, LIMITS.jobNameChars)
  if (!name) throw new Error('Give the job a name.')
  return {
    name,
    jobDescription: cleanProfileText(record.jobDescription, LIMITS.jobDescriptionChars),
    companyName: cleanSingleLine(record.companyName, LIMITS.companyNameChars),
    companyWebsite: cleanSingleLine(record.companyWebsite, LIMITS.companyWebsiteChars),
    companySocial: cleanSingleLine(record.companySocial, LIMITS.companySocialChars)
  }
}

function isEntryLike(value: unknown): value is CoachProfile {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as CoachProfile).id === 'string' &&
    (value as CoachProfile).id &&
    typeof (value as CoachProfile).name === 'string' &&
    (value as CoachProfile).name
  )
}

function normalizeActiveId(entriesValue: unknown, activeIdValue: unknown): string | null {
  const activeId = typeof activeIdValue === 'string' ? activeIdValue : null
  if (!activeId || !Array.isArray(entriesValue)) return null
  return entriesValue.some((entry) => isEntryLike(entry) && entry.id === activeId) ? activeId : null
}

function entryId(entry: CoachProfile): string {
  return entry.id.slice(0, LIMITS.profileIdChars)
}

function entryUpdatedAt(entry: CoachProfile): string {
  return cleanSingleLine(entry.updatedAt, 40)
}

/** Defensively validates persisted profile data loaded from disk. */
export function normalizePersistedProfiles(
  profilesValue: unknown,
  activeIdValue: unknown
): { profiles: CoachProfile[]; activeProfileId: string | null } {
  if (!Array.isArray(profilesValue)) return { profiles: [], activeProfileId: null }
  const knownIds = new Set<string>()
  const profiles: CoachProfile[] = []
  for (const raw of profilesValue.slice(0, LIMITS.profileCount)) {
    if (!isEntryLike(raw)) continue
    if (knownIds.has(raw.id)) continue
    knownIds.add(raw.id)
    try {
      profiles.push({
        id: entryId(raw),
        updatedAt: entryUpdatedAt(raw),
        ...normalizeProfileFields(raw)
      })
    } catch {
      continue
    }
  }
  return { profiles, activeProfileId: normalizeActiveId(profilesValue, activeIdValue) }
}

/** Defensively validates persisted job data loaded from disk. */
export function normalizePersistedJobs(
  jobsValue: unknown,
  activeIdValue: unknown
): { jobs: CoachJob[]; activeJobId: string | null } {
  if (!Array.isArray(jobsValue)) return { jobs: [], activeJobId: null }
  const knownIds = new Set<string>()
  const jobs: CoachJob[] = []
  for (const entry of jobsValue.slice(0, LIMITS.jobCount)) {
    if (!isEntryLike(entry)) continue
    if (knownIds.has(entry.id)) continue
    knownIds.add(entry.id)
    const raw = entry as CoachProfile & { companyBrief?: unknown }
    try {
      jobs.push({
        id: entryId(raw),
        updatedAt: entryUpdatedAt(raw),
        companyBrief: typeof raw.companyBrief === 'string' ? raw.companyBrief : '',
        ...normalizeJobFields(raw)
      })
    } catch {
      continue
    }
  }
  return { jobs, activeJobId: normalizeActiveId(jobsValue, activeIdValue) }
}
