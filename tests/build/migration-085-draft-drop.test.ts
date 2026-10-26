import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 085 drops a draft kwenta_group_detail(uuid, integer) overload before creating anything. The SQL
 * harness applies migrations to a fresh database where that overload never existed, so no suite
 * could notice the statement going missing; an installed app's one-argument call would then be
 * ambiguous (PGRST203) on any database that had the draft.
 */
const sql = readFileSync(resolve(__dirname, '../../supabase/migrations/085_group_bills_paging.sql'), 'utf8')

describe('migration 085 drops the draft kwenta_group_detail overload', () => {
  it('drops kwenta_group_detail(uuid, integer) before the first CREATE of kwenta_group_detail', () => {
    const drop = sql.indexOf('DROP FUNCTION IF EXISTS public.kwenta_group_detail(uuid, integer);')
    const create = sql.indexOf('CREATE OR REPLACE FUNCTION public.kwenta_group_detail(')
    expect(drop).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(-1)
    expect(drop).toBeLessThan(create)
  })
})
