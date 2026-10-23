import { describe, expect, it } from 'vitest'
import { LIMITS } from '../shared/contracts'
import {
  applyCompanyBrief,
  cleanProfileText,
  normalizeJobFields,
  normalizePersistedProfiles,
  normalizeProfileFields
} from '../shared/coach-profiles'
import type { CoachJob } from '../shared/contracts'

describe('delayed company research results', () => {
  const job: CoachJob = { id: 'job-a', name: 'Job A', jobDescription: 'Original job description', companyName: 'Company A', companyWebsite: 'https://a.example', companySocial: '', companyBrief: '', updatedAt: '2026-10-21T00:00:00Z' }
  it('preserves jobs and edits added after research began', () => {
    const edited = { ...job, name: 'Edited title', jobDescription: 'Updated description' }
    const other = { ...job, id: 'job-b', companyName: 'Company B' }
    const jobs = [edited, other]
    expect(applyCompanyBrief(jobs, job, 'New briefing')).toEqual([{ ...edited, companyBrief: 'New briefing' }, other])
    expect(jobs[0].companyBrief).toBe('')
  })
  it('does not resurrect a job deleted during research', () => {
    expect(() => applyCompanyBrief([], job, 'Old result')).toThrow(/deleted/)
  })
  it.each(['companyName', 'companyWebsite', 'companySocial'] as const)('rejects a result when %s changed during research', field => {
    expect(() => applyCompanyBrief([{ ...job, [field]: 'Changed company' }], job, 'Wrong briefing')).toThrow(/details changed/)
  })
})

describe('profile text cleaning', () => {
  it('preserves newlines and trims outer whitespace', () => {
    expect(cleanProfileText('  line one\nline two  \n', 1_000)).toBe('line one\nline two')
  })

  it('strips NUL characters and enforces the cap', () => {
    expect(cleanProfileText('bad\u0000value', 1_000)).toBe('badvalue')
    expect(cleanProfileText('x'.repeat(5_000), LIMITS.profileDetailsChars)).toHaveLength(LIMITS.profileDetailsChars)
    expect(cleanProfileText(42, 10)).toBe('')
  })
})

describe('profile field normalization', () => {
  it('requires a name and caps every field', () => {
    expect(() => normalizeProfileFields({ name: '   ' })).toThrow(/name/i)

    const fields = normalizeProfileFields({
      name: '  Frontend developer ',
      details: ' 5 years of React ',
      resumeText: 'resume body'
    })
    expect(fields.name).toBe('Frontend developer')
    expect(fields.details).toBe('5 years of React')
    expect(fields.resumeText).toBe('resume body')
  })

  it('ignores non-object input', () => {
    expect(() => normalizeProfileFields(null)).toThrow()
    expect(() => normalizeProfileFields('profile')).toThrow()
  })
})

describe('job field normalization', () => {
  it('requires a name and keeps single-line fields on one line', () => {
    const fields = normalizeJobFields({
      name: '  Senior frontend role ',
      jobDescription: 'JD body',
      companyName: 'Acme\nCorp',
      companyWebsite: 'https://acme.example',
      companySocial: 'https://linkedin.com/in/acme'
    })
    expect(fields.name).toBe('Senior frontend role')
    expect(fields.jobDescription).toBe('JD body')
    expect(fields.companyName).toBe('Acme Corp')
    expect(fields.companyWebsite).toBe('https://acme.example')
    expect(fields.companySocial).toBe('https://linkedin.com/in/acme')
  })

  it('rejects an empty job name', () => {
    expect(() => normalizeJobFields({ name: '   ' })).toThrow(/name/i)
    expect(() => normalizeJobFields(null)).toThrow()
  })
})

describe('persisted profile validation', () => {
  const valid = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Profile A',
    details: '',
    resumeText: '',
    jobDescription: '',
    companyName: '',
    companyWebsite: '',
    companySocial: '',
    companyBrief: 'brief',
    updatedAt: '2026-10-04T00:00:00.000Z'
  }

  it('drops malformed entries and duplicate ids', () => {
    const result = normalizePersistedProfiles([valid, { id: '', name: 'broken' }, valid, 'junk', 3], valid.id)
    expect(result.profiles).toHaveLength(1)
    expect(result.profiles[0].name).toBe('Profile A')
    expect(result.activeProfileId).toBe(valid.id)
  })

  it('clears an active id that no longer exists and caps the count', () => {
    const many = Array.from({ length: LIMITS.profileCount + 5 }, (_, index) => ({
      ...valid,
      id: `id-${index}`,
      name: `Profile ${index}`
    }))
    const result = normalizePersistedProfiles(many, 'id-30')
    expect(result.profiles).toHaveLength(LIMITS.profileCount)
    expect(result.activeProfileId).toBeNull()
  })

  it('returns an empty list for non-array data', () => {
    expect(normalizePersistedProfiles('junk', null)).toEqual({ profiles: [], activeProfileId: null })
  })
})
