import { useState, useEffect } from 'react'
import '../css/Tournament.css'

const STORAGE_KEY = 'dilaab-tournament-state'
const QUALIFIERS_PER_GROUP = 2
const MIN_PARTICIPANTS = 3
const MIN_POOL_SIZE = 2
const POOL_TARGET_SIZE = 5 // suggested pools aim for ~5 players each (16 -> 5/5/6, 11 -> 5/6)
const MAX_COURTS = 8
const LONG_WAIT_MINUTES = 15

const STAGES = [
  { key: 'setup', label: 'Setup' },
  { key: 'groups', label: 'Pool play' },
  { key: 'bracket', label: 'Playoffs' },
]

function range(n) {
  return Array.from({ length: n }, (_, i) => i + 1)
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function createTournament(id, name) {
  return {
    id,
    name,
    status: 'setup', // 'setup' | 'groups' | 'bracket'
    poolSizes: [], // size of each pool, e.g. [5, 5, 6]
    poolTouched: false, // true once the user typed a pool count / pool size themselves
    courtCount: 2,
    participants: [],
    groups: [],
    coinToss: {}, // playerId -> fixed random rank, assigned once when pools are generated
    rounds: [], // built ONE AT A TIME as each round completes: [{ label, matches, standby, standbyNote }]
    lastPlayed: {},
    idCounter: 1,
  }
}

function normalizeTournament(t) {
  const merged = {
    poolSizes: [],
    poolTouched: false,
    courtCount: 2,
    participants: [],
    groups: [],
    coinToss: {},
    rounds: [],
    lastPlayed: {},
    idCounter: 1,
    ...t,
    status: t.status === 'in-progress' ? 'bracket' : t.status || 'setup',
  }
  // Rounds saved by an older version used a different shape (array-of-array
  // with `.next` links, or missing `label`/`standby`). That's incompatible
  // with the dynamic round generator below, so fall back to pool play
  // rather than risk rendering a broken bracket.
  const looksIncompatible =
    merged.rounds.length > 0 && (Array.isArray(merged.rounds[0]) || !('matches' in merged.rounds[0]))
  if (looksIncompatible) {
    return { ...merged, rounds: [], status: merged.groups.length ? 'groups' : 'setup' }
  }
  return merged
}

// ---------- pool play helpers ----------

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Split `total` as evenly as possible into exactly `parts` pools. Sizes never
// differ by more than 1 and the bigger pools come last:
//   16 players, 3 pools -> [5, 5, 6]      11 players, 2 pools -> [5, 6]
function evenSplit(total, parts) {
  if (parts <= 0) return []
  const base = Math.floor(total / parts)
  const extra = total % parts
  return Array.from({ length: parts }, (_, i) => base + (i >= parts - extra ? 1 : 0))
}

function maxPoolsFor(participantCount) {
  return Math.max(1, Math.floor(participantCount / MIN_POOL_SIZE))
}

function suggestPoolCount(participantCount) {
  return Math.max(1, Math.min(Math.round(participantCount / POOL_TARGET_SIZE), maxPoolsFor(participantCount)))
}

// Keeps the total at `total` after the participant list changed, nudging the
// pool sizes as little as possible (adds to the smallest pool, removes from
// the largest).
function rebalanceSizes(sizes, total) {
  const next = [...sizes]
  let sum = next.reduce((a, b) => a + b, 0)
  while (sum < total) {
    const idx = next.lastIndexOf(Math.min(...next))
    next[idx] += 1
    sum += 1
  }
  while (sum > total) {
    const idx = next.indexOf(Math.max(...next))
    if (next[idx] <= MIN_POOL_SIZE) break
    next[idx] -= 1
    sum -= 1
  }
  return next
}

// Pure: returns the same object when nothing needs to change.
//  - untouched config: always the suggested even split for the current head count
//  - user-edited config: keep their pool count/sizes, only fix the total
function syncPools(t) {
  const n = t.participants.length
  if (n < MIN_PARTICIPANTS) return t.poolSizes.length ? { ...t, poolSizes: [] } : t

  const sizes = t.poolSizes
  if (!t.poolTouched) {
    const want = evenSplit(n, suggestPoolCount(n))
    return sizes.length === want.length && sizes.every((s, i) => s === want[i]) ? t : { ...t, poolSizes: want }
  }
  if (sizes.length === 0) return { ...t, poolSizes: evenSplit(n, suggestPoolCount(n)) }
  if (sizes.length > maxPoolsFor(n)) return { ...t, poolSizes: evenSplit(n, maxPoolsFor(n)) }
  const sum = sizes.reduce((a, b) => a + b, 0)
  return sum === n ? t : { ...t, poolSizes: rebalanceSizes(sizes, n) }
}

function buildGroups(participants, poolSizes) {
  const shuffled = shuffle(participants)
  let cursor = 0

  return poolSizes.map((size, gi) => {
    const members = shuffled.slice(cursor, cursor + size)
    cursor += size

    const matches = []
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        matches.push({
          id: `g${gi}-${i}-${j}`,
          aId: members[i].id,
          bId: members[j].id,
          scoreA: '',
          scoreB: '',
          winnerId: null,
          status: 'ready', // 'ready' | 'live' | 'completed'
          court: null,
        })
      }
    }

    return {
      id: `group-${gi}`,
      name: `Pool ${String.fromCharCode(65 + gi)}`,
      playerIds: members.map((p) => p.id),
      matches,
    }
  })
}

// ---------- the tiebreaker / "score advantage" chain ----------
// 1. Head-to-head (only meaningful if both players shared a pool)
// 2. Point differential (points scored - points allowed)
// 3. Total points scored
// 4. Fewest points allowed
// 5. Initial seed / "coin toss" (assigned once, fixed for the rest of the event)

function headToHeadInGroup(a, b, group) {
  if (!group) return 0
  const m = group.matches.find(
    (x) =>
      x.status === 'completed' &&
      ((x.aId === a.id && x.bId === b.id) || (x.aId === b.id && x.bId === a.id))
  )
  if (!m) return 0
  return m.winnerId === a.id ? -1 : 1
}

function tieBreakChain(a, b, { groupsById, coinToss }) {
  if (a.groupId && a.groupId === b.groupId) {
    const h2h = headToHeadInGroup(a, b, groupsById[a.groupId])
    if (h2h !== 0) return h2h
  }
  if (b.diff !== a.diff) return b.diff - a.diff
  if (b.pf !== a.pf) return b.pf - a.pf
  if (a.pa !== b.pa) return a.pa - b.pa
  const ca = coinToss?.[a.id] ?? 0
  const cb = coinToss?.[b.id] ?? 0
  return ca - cb
}

// Ranking: wins, then the tiebreak chain above.
function computeStandings(group, byId, coinToss) {
  const rows = group.playerIds.map((id, order) => ({
    id,
    groupId: group.id,
    name: byId[id]?.name ?? '—',
    order,
    played: 0,
    wins: 0,
    losses: 0,
    pf: 0,
    pa: 0,
    diff: 0,
  }))
  const rowById = Object.fromEntries(rows.map((r) => [r.id, r]))

  group.matches.forEach((m) => {
    if (m.status !== 'completed') return
    const a = rowById[m.aId]
    const b = rowById[m.bId]
    if (!a || !b) return
    const sa = Number(m.scoreA)
    const sb = Number(m.scoreB)
    a.played += 1
    b.played += 1
    a.pf += sa
    a.pa += sb
    b.pf += sb
    b.pa += sa
    if (m.winnerId === a.id) {
      a.wins += 1
      b.losses += 1
    } else {
      b.wins += 1
      a.losses += 1
    }
  })
  rows.forEach((r) => {
    r.diff = r.pf - r.pa
  })

  const groupsById = { [group.id]: group }
  const compare = (a, b) => b.wins - a.wins || tieBreakChain(a, b, { groupsById, coinToss })

  rows.sort((a, b) => compare(a, b) || a.order - b.order)
  return { rows, compare }
}

// Ranks qualifiers of the SAME tier (all pool winners together, or all
// runners-up together) across different pools. Primary metric is win rate
// (pools can differ in size), ties broken by the chain above.
function rankTier(tierRows, groupsById, coinToss) {
  return [...tierRows].sort((a, b) => {
    const pa = a.played ? a.wins / a.played : 0
    const pb = b.played ? b.wins / b.played : 0
    if (pb !== pa) return pb - pa
    return tieBreakChain(a, b, { groupsById, coinToss })
  })
}

// ---------- score advantage over the WHOLE event (pool play + playoffs) ----------

// Every finished match so far, as plain results.
function collectResults(t) {
  const out = []
  t.groups.forEach((g) =>
    g.matches.forEach((m) => {
      if (m.status !== 'completed') return
      out.push({ aId: m.aId, bId: m.bId, scoreA: Number(m.scoreA), scoreB: Number(m.scoreB) })
    })
  )
  t.rounds.forEach((round) =>
    round.matches.forEach((m) => {
      if (m.status !== 'completed') return
      out.push({ aId: m.playerA.id, bId: m.playerB.id, scoreA: Number(m.scoreA), scoreB: Number(m.scoreB) })
    })
  )
  return out
}

// Best score advantage first: win rate over every match played so far, then
// the tiebreak chain (head-to-head, point differential, points scored, fewest
// points allowed, coin toss). Each returned row keeps the original `player`.
function rankByScoreAdvantage(entrants, t) {
  const groupOf = {}
  t.groups.forEach((g) =>
    g.playerIds.forEach((id) => {
      groupOf[id] = g.id
    })
  )
  const groupsById = Object.fromEntries(t.groups.map((g) => [g.id, g]))

  const rows = entrants.map((player) => ({
    player,
    id: player.id,
    groupId: groupOf[player.id],
    played: 0,
    wins: 0,
    pf: 0,
    pa: 0,
    diff: 0,
  }))
  const rowById = Object.fromEntries(rows.map((r) => [r.id, r]))

  collectResults(t).forEach((r) => {
    const a = rowById[r.aId]
    const b = rowById[r.bId]
    if (a) {
      a.played += 1
      a.pf += r.scoreA
      a.pa += r.scoreB
      if (r.scoreA > r.scoreB) a.wins += 1
    }
    if (b) {
      b.played += 1
      b.pf += r.scoreB
      b.pa += r.scoreA
      if (r.scoreB > r.scoreA) b.wins += 1
    }
  })
  rows.forEach((r) => {
    r.diff = r.pf - r.pa
  })

  return rows.sort((a, b) => {
    const ra = a.played ? a.wins / a.played : 0
    const rb = b.played ? b.wins / b.played : 0
    if (rb !== ra) return rb - ra
    return tieBreakChain(a, b, { groupsById, coinToss: t.coinToss })
  })
}

// ---------- playoff bracket helpers (built ONE round at a time) ----------

function roundLabelFor(entrantCount) {
  if (entrantCount <= 2) return 'Final'
  if (entrantCount <= 4) return 'Semifinals'
  if (entrantCount <= 8) return 'Quarterfinals'
  return `Round of ${entrantCount}`
}

function toPlayer(q) {
  return { id: q.id, name: q.name, seed: q.seed, tag: q.tag }
}

// Round 1 with 2+ pools: every pool winner plays a runner-up from a
// DIFFERENT pool. Best winner gets the weakest runner-up (standard
// seeding), with a swap pass so nobody plays their own pool's runner-up.
function buildRound1FromPools(winners, runnersUp) {
  const count = winners.length
  const assigned = winners.map((_, i) => runnersUp[count - 1 - i])
  const clash = (i) => winners[i].groupId === assigned[i].groupId

  for (let i = 0; i < count; i += 1) {
    if (!clash(i)) continue
    for (let j = 0; j < count; j += 1) {
      if (j === i) continue
      ;[assigned[i], assigned[j]] = [assigned[j], assigned[i]]
      if (!clash(i) && !clash(j)) break
      ;[assigned[i], assigned[j]] = [assigned[j], assigned[i]]
    }
  }

  const matches = winners.map((w, i) => ({
    playerA: toPlayer(w),
    playerB: toPlayer(assigned[i]),
    scoreA: '',
    scoreB: '',
    winnerId: null,
    status: 'ready',
    court: null,
  }))

  return { label: roundLabelFor(count * 2), matches, standby: null, standbyNote: '' }
}

// Every round after that (and round 1 when there's only a single pool):
// once the qualifiers / winners are known, they are ranked by SCORE ADVANTAGE.
// If the number of advancing players is ODD, the one with the best score
// advantage gets the standby (bye) and the remaining, even number are paired
// best-vs-worst and play for real. Decided fresh each time, only once the
// results are in — never pre-assigned by position or seed.
function buildNextRound(entrants, t) {
  const ranked = rankByScoreAdvantage(entrants, t)

  let standby = null
  let standbyNote = ''
  let playing = ranked
  if (ranked.length % 2 === 1) {
    const top = ranked[0]
    standby = top.player
    standbyNote = `Best score advantage: ${top.wins}-${top.played - top.wins} · ${top.diff >= 0 ? '+' : ''}${top.diff} pts`
    playing = ranked.slice(1)
  }

  const matches = []
  for (let i = 0; i < playing.length / 2; i += 1) {
    matches.push({
      playerA: playing[i].player,
      playerB: playing[playing.length - 1 - i].player,
      scoreA: '',
      scoreB: '',
      winnerId: null,
      status: 'ready',
      court: null,
    })
  }

  return { label: roundLabelFor(ranked.length), matches, standby, standbyNote }
}

function roundComplete(round) {
  return round.matches.every((m) => m.winnerId != null)
}

function roundWinners(round) {
  const winners = round.matches.map((m) => (m.playerA.id === m.winnerId ? m.playerA : m.playerB))
  return round.standby ? [...winners, round.standby] : winners
}

function roundEntrants(round) {
  const players = round.matches.flatMap((m) => [m.playerA, m.playerB])
  return round.standby ? [...players, round.standby] : players
}

// For the setup-phase preview: simulate the same odd/even reduction so the
// "X rounds, Y byes" estimate is accurate before anything is generated.
function simulateBracketShape(entrantCount) {
  let n = entrantCount
  let rounds = 0
  let byes = 0
  while (n > 1) {
    rounds += 1
    if (n % 2 === 1) {
      byes += 1
      n = (n - 1) / 2 + 1
    } else {
      n = n / 2
    }
  }
  return { rounds, byes }
}

// ---------- scheduling helpers ----------

function getMatch(t, ref) {
  return ref.kind === 'group' ? t.groups[ref.g].matches[ref.m] : t.rounds[ref.r].matches[ref.m]
}

// Every match that can be played right now ('ready') or is on court ('live').
function listMatches(t, byId) {
  const out = []
  if (t.status === 'groups') {
    t.groups.forEach((g, gi) =>
      g.matches.forEach((m, mi) => {
        if (m.status === 'completed') return
        out.push({
          key: `g-${gi}-${mi}`,
          ref: { kind: 'group', g: gi, m: mi },
          label: g.name,
          a: { id: m.aId, name: byId[m.aId]?.name ?? '—' },
          b: { id: m.bId, name: byId[m.bId]?.name ?? '—' },
          status: m.status,
          court: m.court ?? null,
        })
      })
    )
  } else if (t.status === 'bracket') {
    t.rounds.forEach((round, ri) =>
      round.matches.forEach((m, mi) => {
        if (m.status === 'completed') return
        out.push({
          key: `b-${ri}-${mi}`,
          ref: { kind: 'bracket', r: ri, m: mi },
          label: round.label,
          a: m.playerA,
          b: m.playerB,
          status: m.status,
          court: m.court ?? null,
        })
      })
    )
  }
  return out
}

const canSubmit = (m) => m.scoreA !== '' && m.scoreB !== '' && m.scoreA !== m.scoreB

// ---------- component ----------

function Tournament() {
  const [saved] = useState(() => loadSaved())
  const [tournaments, setTournaments] = useState(() =>
    saved?.tournaments?.length
      ? saved.tournaments.map(normalizeTournament)
      : [createTournament('t-1', 'Championship')]
  )
  const [activeId, setActiveId] = useState(() => saved?.activeId ?? tournaments[0]?.id ?? 't-1')
  const [nameInput, setNameInput] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [newTournamentName, setNewTournamentName] = useState('')
  const [editingTournamentName, setEditingTournamentName] = useState(false)
  const [tournamentNameInput, setTournamentNameInput] = useState('')
  const [now, setNow] = useState(() => Date.now())

  // what is typed in the pool count / pool size boxes (kept as text so typing is never fought)
  const [poolCountDraft, setPoolCountDraft] = useState('')
  const [poolSizeDrafts, setPoolSizeDrafts] = useState([])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(timer)
  }, [])

  const active = tournaments.find((t) => t.id === activeId) || tournaments[0]
  const byId = Object.fromEntries(active.participants.map((p) => [p.id, p]))
  const participantCount = active.participants.length
  const maxPools = maxPoolsFor(participantCount)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ tournaments, activeId }))
    } catch (err) {
      console.error('Could not save tournament state:', err)
    }
  }, [tournaments, activeId])

  function updateActive(updater) {
    setTournaments((prev) => prev.map((t) => (t.id === active.id ? updater(t) : t)))
  }

  function nextId() {
    const id = active.idCounter + 1
    updateActive((t) => ({ ...t, idCounter: id }))
    return id
  }

  // While in setup, keep the pool layout valid as people are added/removed:
  // untouched -> suggested even split, edited -> same pool count, total fixed.
  useEffect(() => {
    if (active.status !== 'setup') return
    if (syncPools(active) !== active) updateActive((t) => syncPools(t))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.id, active.status, active.participants.length])

  // Show the applied pool layout in the text boxes whenever it changes from
  // anywhere (switching tournament, balance button, participant list changes).
  // Typing never triggers this by itself, because an invalid/partial number
  // is never applied.
  const poolSizesKey = active.poolSizes.join(',')
  useEffect(() => {
    setPoolCountDraft(active.poolSizes.length ? String(active.poolSizes.length) : '')
    setPoolSizeDrafts(active.poolSizes.map(String))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.id, poolSizesKey])

  // ---- tournament CRUD ----
  function createNewTournament(e) {
    e.preventDefault()
    const name = newTournamentName.trim() || `Tournament ${tournaments.length + 1}`
    const id = `t-${Date.now()}`
    setTournaments((prev) => [...prev, createTournament(id, name)])
    setActiveId(id)
    setNewTournamentName('')
  }

  function deleteActiveTournament() {
    if (tournaments.length <= 1) {
      alert('You must have at least one tournament.')
      return
    }
    const confirmed = window.confirm(`Delete "${active.name}"? Its groups, bracket and results will be permanently lost.`)
    if (!confirmed) return
    const remaining = tournaments.filter((t) => t.id !== active.id)
    setTournaments(remaining)
    setActiveId(remaining[0].id)
  }

  function saveTournamentName() {
    const trimmed = tournamentNameInput.trim()
    if (trimmed) updateActive((t) => ({ ...t, name: trimmed }))
    setEditingTournamentName(false)
  }

  // ---- participant CRUD (setup phase only) ----
  function addParticipant(e) {
    e.preventDefault()
    const name = nameInput.trim()
    if (!name) return
    const id = nextId()
    updateActive((t) => ({ ...t, participants: [...t.participants, { id, name }] }))
    setNameInput('')
  }
  function startEdit(p) {
    setEditingId(p.id)
    setEditValue(p.name)
  }
  function cancelEdit() {
    setEditingId(null)
    setEditValue('')
  }
  function saveEdit(id) {
    const trimmed = editValue.trim()
    if (trimmed) {
      updateActive((t) => ({
        ...t,
        participants: t.participants.map((p) => (p.id === id ? { ...p, name: trimmed } : p)),
      }))
    }
    setEditingId(null)
    setEditValue('')
  }
  function removeParticipant(id) {
    updateActive((t) => ({ ...t, participants: t.participants.filter((p) => p.id !== id) }))
  }

  // ---- pool count / pool size: every valid number applies instantly ----
  function handlePoolCountChange(value) {
    if (!/^\d{0,3}$/.test(value)) return
    setPoolCountDraft(value)
    const n = Number(value)
    // only a number that is actually allowed is applied; anything else just
    // waits (and shows a hint) instead of being clamped to the maximum
    if (value !== '' && n >= 1 && n <= maxPools) {
      updateActive((t) => ({ ...t, poolSizes: evenSplit(t.participants.length, n), poolTouched: true }))
    }
  }

  function handlePoolCountBlur() {
    setPoolCountDraft(active.poolSizes.length ? String(active.poolSizes.length) : '')
  }

  function handlePoolSizeChange(index, value) {
    if (!/^\d{0,3}$/.test(value)) return
    setPoolSizeDrafts((prev) => {
      const next = [...prev]
      next[index] = value
      return next
    })
    const n = Number(value)
    if (value !== '' && n >= MIN_POOL_SIZE) {
      updateActive((t) => {
        const poolSizes = [...t.poolSizes]
        poolSizes[index] = n
        return { ...t, poolSizes, poolTouched: true }
      })
    }
  }

  function handlePoolSizeBlur(index) {
    setPoolSizeDrafts((prev) => {
      const next = [...prev]
      next[index] = String(active.poolSizes[index] ?? '')
      return next
    })
  }

  function balancePools() {
    updateActive((t) => ({
      ...t,
      poolSizes: evenSplit(t.participants.length, t.poolSizes.length || 1),
      poolTouched: true,
    }))
  }

  function setCourtCount(value) {
    updateActive((t) => ({ ...t, courtCount: Number(value) }))
  }

  // ---- lifecycle: setup -> pool play -> playoffs ----
  function startGroupStage() {
    if (!canGeneratePools) return
    const groups = buildGroups(active.participants, active.poolSizes)
    const coinToss = Object.fromEntries(shuffle(active.participants).map((p, i) => [p.id, i]))
    updateActive((t) => ({ ...t, groups, coinToss, rounds: [], lastPlayed: {}, status: 'groups' }))
  }

  function startKnockout() {
    const groupsById = Object.fromEntries(active.groups.map((g) => [g.id, g]))

    // Single pool: everyone in it advances (seeded by standings) instead of
    // just the top 2 — there's no other pool to cross-pair against anyway.
    // If that number is odd, the best score advantage gets the standby.
    if (active.groups.length === 1) {
      const { rows } = computeStandings(active.groups[0], byId, active.coinToss)
      const qualifiers = rows.map((row, i) => ({ id: row.id, name: row.name, seed: i + 1, tag: `A${i + 1}` }))
      const round1 = buildNextRound(qualifiers, active)
      updateActive((t) => ({ ...t, rounds: [round1], status: 'bracket' }))
      return
    }

    const winners = []
    const runnersUp = []
    active.groups.forEach((group) => {
      const { rows } = computeStandings(group, byId, active.coinToss)
      rows.slice(0, QUALIFIERS_PER_GROUP).forEach((row, i) => {
        const q = {
          id: row.id,
          name: row.name,
          groupId: group.id,
          wins: row.wins,
          played: row.played,
          pf: row.pf,
          pa: row.pa,
          diff: row.diff,
          tag: `${group.name.replace('Pool ', '')}${i + 1}`,
        }
        if (i === 0) winners.push(q)
        else runnersUp.push(q)
      })
    })

    const seededWinners = rankTier(winners, groupsById, active.coinToss)
    const seededRunnersUp = rankTier(runnersUp, groupsById, active.coinToss)
    seededWinners.forEach((q, i) => (q.seed = i + 1))
    seededRunnersUp.forEach((q, i) => (q.seed = seededWinners.length + i + 1))

    const round1 = buildRound1FromPools(seededWinners, seededRunnersUp)
    updateActive((t) => ({ ...t, rounds: [round1], status: 'bracket' }))
  }

  function backToGroups() {
    const confirmed = window.confirm('Go back to pool play? This clears the playoff bracket (pool results are kept).')
    if (!confirmed) return
    updateActive((t) => ({ ...t, rounds: [], status: 'groups' }))
  }

  function editParticipants() {
    const confirmed = window.confirm(
      'Go back and edit participants? This clears the groups, bracket and all match results (the participant list itself is kept).'
    )
    if (!confirmed) return
    updateActive((t) => ({ ...t, groups: [], rounds: [], lastPlayed: {}, status: 'setup' }))
  }

  function endTournament() {
    const confirmed = window.confirm(`End "${active.name}"? This clears every participant, group, match, and result so you can host a new event.`)
    if (!confirmed) return
    updateActive((t) => ({
      ...t,
      participants: [],
      poolSizes: [],
      poolTouched: false,
      groups: [],
      rounds: [],
      lastPlayed: {},
      status: 'setup',
      idCounter: 1,
    }))
  }

  // ---- group match scoring ----
  function setGroupScore(groupIndex, matchIndex, team, value) {
    if (value !== '' && !/^\d{0,2}$/.test(value)) return
    updateActive((t) => {
      const groups = structuredClone(t.groups)
      groups[groupIndex].matches[matchIndex][team === 'A' ? 'scoreA' : 'scoreB'] = value
      return { ...t, groups }
    })
  }

  function startGroupMatch(groupIndex, matchIndex, court) {
    updateActive((t) => {
      const groups = structuredClone(t.groups)
      groups[groupIndex].matches[matchIndex].status = 'live'
      groups[groupIndex].matches[matchIndex].court = court
      return { ...t, groups }
    })
  }

  function stopGroupMatch(groupIndex, matchIndex) {
    updateActive((t) => {
      const groups = structuredClone(t.groups)
      groups[groupIndex].matches[matchIndex].status = 'ready'
      groups[groupIndex].matches[matchIndex].court = null
      return { ...t, groups }
    })
  }

  function finishGroupMatch(groupIndex, matchIndex) {
    const match = active.groups[groupIndex].matches[matchIndex]
    const scoreA = Number(match.scoreA)
    const scoreB = Number(match.scoreB)
    if (match.scoreA === '' || match.scoreB === '' || scoreA === scoreB) return
    const winnerId = scoreA > scoreB ? match.aId : match.bId
    const stamp = Date.now()
    updateActive((t) => {
      const groups = structuredClone(t.groups)
      const m = groups[groupIndex].matches[matchIndex]
      m.winnerId = winnerId
      m.status = 'completed'
      m.court = null
      return { ...t, groups, lastPlayed: { ...t.lastPlayed, [match.aId]: stamp, [match.bId]: stamp } }
    })
  }

  function editGroupMatch(groupIndex, matchIndex) {
    updateActive((t) => {
      const groups = structuredClone(t.groups)
      const m = groups[groupIndex].matches[matchIndex]
      m.winnerId = null
      m.scoreA = ''
      m.scoreB = ''
      m.status = 'ready'
      m.court = null
      return { ...t, groups }
    })
  }

  // ---- bracket match scoring ----
  function setScore(roundIndex, matchIndex, team, value) {
    if (value !== '' && !/^\d{0,2}$/.test(value)) return
    updateActive((t) => {
      const rounds = structuredClone(t.rounds)
      rounds[roundIndex].matches[matchIndex][team === 'A' ? 'scoreA' : 'scoreB'] = value
      return { ...t, rounds }
    })
  }

  function startBracketMatch(roundIndex, matchIndex, court) {
    updateActive((t) => {
      const rounds = structuredClone(t.rounds)
      rounds[roundIndex].matches[matchIndex].status = 'live'
      rounds[roundIndex].matches[matchIndex].court = court
      return { ...t, rounds }
    })
  }

  function stopBracketMatch(roundIndex, matchIndex) {
    updateActive((t) => {
      const rounds = structuredClone(t.rounds)
      rounds[roundIndex].matches[matchIndex].status = 'ready'
      rounds[roundIndex].matches[matchIndex].court = null
      return { ...t, rounds }
    })
  }

  function finishMatch(roundIndex, matchIndex) {
    const round = active.rounds[roundIndex]
    const match = round.matches[matchIndex]
    const scoreA = Number(match.scoreA)
    const scoreB = Number(match.scoreB)
    if (match.scoreA === '' || match.scoreB === '' || scoreA === scoreB) return
    const winner = scoreA > scoreB ? match.playerA : match.playerB
    const stamp = Date.now()

    updateActive((t) => {
      const rounds = structuredClone(t.rounds)
      const r = rounds[roundIndex]
      r.matches[matchIndex].winnerId = winner.id
      r.matches[matchIndex].status = 'completed'
      r.matches[matchIndex].court = null

      // round finished -> draw the next one; if the number of winners is odd,
      // the best score advantage gets the standby (this match's score counts)
      if (roundComplete(r)) {
        const entrants = roundWinners(r)
        if (entrants.length >= 2) rounds.push(buildNextRound(entrants, { ...t, rounds }))
      }
      return {
        ...t,
        rounds,
        lastPlayed: { ...t.lastPlayed, [match.playerA.id]: stamp, [match.playerB.id]: stamp },
      }
    })
  }

  // Editing a result discards every round built after it, since they were
  // built from an outcome that's no longer true.
  function editMatch(roundIndex, matchIndex) {
    const hasLaterRounds = roundIndex < active.rounds.length - 1
    if (hasLaterRounds) {
      const confirmed = window.confirm(
        'Changing this result will erase every round built after it, since they depended on this outcome. Continue?'
      )
      if (!confirmed) return
    }
    updateActive((t) => {
      const rounds = structuredClone(t.rounds).slice(0, roundIndex + 1)
      const m = rounds[roundIndex].matches[matchIndex]
      m.winnerId = null
      m.scoreA = ''
      m.scoreB = ''
      m.status = 'ready'
      m.court = null
      return { ...t, rounds }
    })
  }

  // Puts the best playable matches (longest-rested players first) on every free court.
  function autoFillCourts() {
    updateActive((t) => {
      const next = structuredClone(t)
      const map = Object.fromEntries(next.participants.map((p) => [p.id, p]))
      const list = listMatches(next, map)
      const live = list.filter((m) => m.status === 'live')
      const busy = new Set(live.flatMap((m) => [m.a.id, m.b.id]))
      const taken = new Set(live.map((m) => m.court))
      const slots = range(Math.max(next.courtCount, ...live.map((m) => m.court ?? 0))).filter((n) => !taken.has(n))

      const stamp = Date.now()
      const rest = (id) => (next.lastPlayed?.[id] ? stamp - next.lastPlayed[id] : 1e9)
      const candidates = list
        .filter((m) => m.status === 'ready')
        .sort((x, y) => rest(y.a.id) + rest(y.b.id) - (rest(x.a.id) + rest(x.b.id)))

      slots.forEach((court) => {
        const pick = candidates.find((m) => !m.picked && !busy.has(m.a.id) && !busy.has(m.b.id))
        if (!pick) return
        pick.picked = true
        busy.add(pick.a.id)
        busy.add(pick.b.id)
        const match = getMatch(next, pick.ref)
        match.status = 'live'
        match.court = court
      })
      return next
    })
  }

  // ---------- derived data ----------
  const lastRound = active.rounds.length ? active.rounds[active.rounds.length - 1] : null
  const champion =
    lastRound && roundComplete(lastRound) && roundWinners(lastRound).length === 1 ? roundWinners(lastRound)[0] : null

  const inPlay = active.status === 'groups' || active.status === 'bracket'
  const matches = inPlay ? listMatches(active, byId) : []
  const liveMatches = matches.filter((m) => m.status === 'live')
  const readyMatches = matches.filter((m) => m.status === 'ready')

  const liveCourtOf = {}
  liveMatches.forEach((m) => {
    liveCourtOf[m.a.id] = m.court
    liveCourtOf[m.b.id] = m.court
  })

  const lastPlayed = active.lastPlayed || {}
  const restMs = (id) => (lastPlayed[id] ? now - lastPlayed[id] : 1e9)

  const infoByKey = {}
  readyMatches.forEach((m) => {
    const blockers = [m.a, m.b].filter((p) => liveCourtOf[p.id] != null)
    infoByKey[m.key] = { playable: blockers.length === 0, blockers }
  })

  const playable = readyMatches
    .filter((m) => infoByKey[m.key].playable)
    .sort((x, y) => restMs(y.a.id) + restMs(y.b.id) - (restMs(x.a.id) + restMs(x.b.id)))
  const blocked = readyMatches.filter((m) => !infoByKey[m.key].playable)

  const courtNumbers = range(Math.max(active.courtCount, ...liveMatches.map((m) => m.court ?? 0)))
  const freeCourts = courtNumbers.filter((n) => !liveMatches.some((m) => m.court === n))

  function buildPlayerBoard() {
    const board = { playing: [], available: [], waiting: [], out: [] }
    if (!inPlay) return board

    const playableIds = new Set(playable.flatMap((m) => [m.a.id, m.b.id]))
    const stage = active.status

    const remaining = {}
    active.groups.forEach((g) =>
      g.matches.forEach((m) => {
        if (m.status === 'completed') return
        remaining[m.aId] = (remaining[m.aId] || 0) + 1
        remaining[m.bId] = (remaining[m.bId] || 0) + 1
      })
    )

    const eliminated = new Set()
    active.rounds.forEach((round) =>
      round.matches.forEach((m) => {
        if (m.status !== 'completed') return
        const loser = m.winnerId === m.playerA.id ? m.playerB : m.playerA
        eliminated.add(loser.id)
      })
    )
    const standbyId = lastRound && lastRound.standby && !roundComplete(lastRound) ? lastRound.standby.id : null

    const entrants =
      stage === 'groups'
        ? active.groups.flatMap((g) => g.playerIds)
        : active.rounds.length
          ? roundEntrants(active.rounds[0]).map((p) => p.id)
          : []

    const restNote = (id) => {
      if (!lastPlayed[id]) return { text: 'Not played yet', long: false }
      const mins = Math.floor((now - lastPlayed[id]) / 60000)
      return { text: mins < 1 ? 'Just finished' : `Rested ${mins} min`, long: mins >= LONG_WAIT_MINUTES }
    }

    entrants.forEach((id) => {
      const name =
        byId[id]?.name ??
        active.rounds.flatMap((r) => r.matches.flatMap((m) => [m.playerA, m.playerB])).find((p) => p?.id === id)?.name ??
        '—'
      const court = liveCourtOf[id]

      if (court != null) {
        board.playing.push({ id, name, note: `Court ${court}` })
      } else if (stage === 'groups') {
        if (!remaining[id]) board.out.push({ id, name, note: 'Pool play done' })
        else if (playableIds.has(id)) {
          const rest = restNote(id)
          board.available.push({ id, name, note: rest.text, long: rest.long })
        } else board.waiting.push({ id, name, note: 'Opponents on court' })
      } else if (champion?.id === id) {
        board.out.push({ id, name, note: 'Champion' })
      } else if (eliminated.has(id)) {
        board.out.push({ id, name, note: 'Eliminated' })
      } else if (id === standbyId) {
        board.waiting.push({ id, name, note: 'On standby' })
      } else if (playableIds.has(id)) {
        const rest = restNote(id)
        board.available.push({ id, name, note: rest.text, long: rest.long })
      } else {
        board.waiting.push({ id, name, note: 'Waiting for bracket' })
      }
    })

    board.available.sort((a, b) => (lastPlayed[a.id] ?? 0) - (lastPlayed[b.id] ?? 0))
    return board
  }
  const board = buildPlayerBoard()

  function nameFor(player) {
    return player ? player.name : null
  }

  // ---- setup: pool count / size validation + preview ----
  const poolTotal = active.poolSizes.reduce((a, b) => a + b, 0)
  const poolTotalValid = participantCount > 0 && poolTotal === participantCount
  const allPoolsMinSize = active.poolSizes.every((s) => s >= MIN_POOL_SIZE)
  const canGeneratePools =
    participantCount >= MIN_PARTICIPANTS && active.poolSizes.length > 0 && poolTotalValid && allPoolsMinSize

  const poolCountTooHigh = poolCountDraft !== '' && Number(poolCountDraft) > maxPools
  const poolCountZero = poolCountDraft !== '' && Number(poolCountDraft) < 1

  const singlePoolFormat = active.poolSizes.length === 1
  const previewQualifiers = singlePoolFormat ? active.poolSizes[0] || 0 : active.poolSizes.length * QUALIFIERS_PER_GROUP
  const previewShape = simulateBracketShape(previewQualifiers)

  const allGroupMatches = active.groups.flatMap((g) => g.matches)
  const playedGroupMatches = allGroupMatches.filter((m) => m.status === 'completed').length
  const groupStageDone = allGroupMatches.length > 0 && playedGroupMatches === allGroupMatches.length

  const stageIndex = STAGES.findIndex((s) => s.key === active.status)
  const stageLabel = { setup: 'setup', groups: 'pool play', bracket: 'playoffs' }

  const boardColumns = [
    { key: 'playing', title: 'On court', tone: 'live', items: board.playing },
    { key: 'available', title: 'Available now', tone: 'ok', items: board.available },
    { key: 'waiting', title: 'Waiting', tone: 'wait', items: board.waiting },
    { key: 'out', title: active.status === 'groups' ? 'Pool play done' : 'Out / champion', tone: 'out', items: board.out },
  ]

  // ---------- court board (shared by pool play and playoffs) ----------
  function renderCourtBoard() {
    const nextUp = playable[0]

    return (
      <div className="court-board">
        <div className="court-board-head">
          <h2 className="t-heading">Courts &amp; players</h2>
          <div className="court-controls">
            <label className="court-count-field">
              <span>Courts</span>
              <select value={active.courtCount} onChange={(e) => setCourtCount(e.target.value)}>
                {range(MAX_COURTS).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn-primary small"
              disabled={freeCourts.length === 0 || playable.length === 0}
              onClick={autoFillCourts}
            >
              Fill free courts
            </button>
          </div>
        </div>

        <div className="courts-live-grid">
          {courtNumbers.map((n) => {
            const live = liveMatches.find((m) => m.court === n)
            const liveMatch = live ? getMatch(active, live.ref) : null

            return (
              <article className={`court-tile ${live ? 'is-live' : ''}`} key={n}>
                <header className="court-tile-head">
                  <span className="court-tile-name">Court {n}</span>
                  {live ? (
                    <span className="t-live-badge">
                      <span className="t-live-dot" /> LIVE
                    </span>
                  ) : (
                    <span className="court-free-tag">FREE</span>
                  )}
                </header>

                {live ? (
                  <>
                    <p className="court-tile-label">{live.label}</p>
                    <div className="court-teams">
                      <label className="court-team">
                        <span className="court-team-name">{live.a.name}</span>
                        <input
                          className="t-score-input"
                          type="text"
                          inputMode="numeric"
                          placeholder="0"
                          value={liveMatch.scoreA}
                          onChange={(e) =>
                            live.ref.kind === 'group'
                              ? setGroupScore(live.ref.g, live.ref.m, 'A', e.target.value)
                              : setScore(live.ref.r, live.ref.m, 'A', e.target.value)
                          }
                        />
                      </label>
                      <span className="court-vs">vs</span>
                      <label className="court-team">
                        <span className="court-team-name">{live.b.name}</span>
                        <input
                          className="t-score-input"
                          type="text"
                          inputMode="numeric"
                          placeholder="0"
                          value={liveMatch.scoreB}
                          onChange={(e) =>
                            live.ref.kind === 'group'
                              ? setGroupScore(live.ref.g, live.ref.m, 'B', e.target.value)
                              : setScore(live.ref.r, live.ref.m, 'B', e.target.value)
                          }
                        />
                      </label>
                    </div>
                    <div className="court-tile-actions">
                      <button
                        className="btn-primary small"
                        disabled={!canSubmit(liveMatch)}
                        onClick={() =>
                          live.ref.kind === 'group' ? finishGroupMatch(live.ref.g, live.ref.m) : finishMatch(live.ref.r, live.ref.m)
                        }
                      >
                        Finish
                      </button>
                      <button
                        className="t-ghost-btn"
                        onClick={() =>
                          live.ref.kind === 'group' ? stopGroupMatch(live.ref.g, live.ref.m) : stopBracketMatch(live.ref.r, live.ref.m)
                        }
                      >
                        Back to queue
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="court-free-note">{nextUp ? `Next: ${nextUp.a.name} vs ${nextUp.b.name}` : 'No match ready to start'}</p>
                    <button
                      className="btn-primary small"
                      disabled={!nextUp}
                      onClick={() =>
                        nextUp &&
                        (nextUp.ref.kind === 'group'
                          ? startGroupMatch(nextUp.ref.g, nextUp.ref.m, n)
                          : startBracketMatch(nextUp.ref.r, nextUp.ref.m, n))
                      }
                    >
                      Start next match
                    </button>
                  </>
                )}
              </article>
            )
          })}
        </div>

        <div className="court-lower">
          <div className="upnext-card">
            <h3 className="court-sub-heading">Up next</h3>
            {playable.length === 0 ? (
              <p className="t-empty-note">
                {liveMatches.length > 0 ? 'Everyone left is on court or waiting on a result.' : 'No matches ready.'}
              </p>
            ) : (
              <ol className="upnext-list">
                {playable.slice(0, 5).map((m, i) => (
                  <li key={m.key}>
                    <span className="upnext-pos">{i + 1}</span>
                    <span className="upnext-match">
                      <span className="upnext-teams">
                        {m.a.name} <em>vs</em> {m.b.name}
                      </span>
                      <span className="upnext-label">{m.label}</span>
                    </span>
                    <button
                      className="t-ghost-btn"
                      disabled={freeCourts.length === 0}
                      onClick={() =>
                        m.ref.kind === 'group' ? startGroupMatch(m.ref.g, m.ref.m, freeCourts[0]) : startBracketMatch(m.ref.r, m.ref.m, freeCourts[0])
                      }
                    >
                      {freeCourts.length > 0 ? `Court ${freeCourts[0]}` : 'Courts full'}
                    </button>
                  </li>
                ))}
              </ol>
            )}

            {blocked.length > 0 && (
              <>
                <h3 className="court-sub-heading">Waiting on a court</h3>
                <ul className="blocked-list">
                  {blocked.slice(0, 4).map((m) => (
                    <li key={m.key}>
                      <span>
                        {m.a.name} vs {m.b.name}
                      </span>
                      <span className="match-wait-tag">{infoByKey[m.key].blockers.map((p) => p.name).join(' & ')} on court</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          <div className="players-board">
            {boardColumns.map((col) => (
              <div className={`board-col is-${col.tone}`} key={col.key}>
                <h4 className="board-col-title">
                  {col.title}
                  <span className="board-count">{col.items.length}</span>
                </h4>
                {col.items.length === 0 ? (
                  <p className="board-empty">—</p>
                ) : (
                  <ul className="board-list">
                    {col.items.map((item) => (
                      <li className={`board-chip ${item.long ? 'is-long' : ''}`} key={item.id}>
                        <span className="board-chip-name">{item.name}</span>
                        <span className="board-chip-note">{item.note}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // ---------- pool standings grid (reused in both Pool Play and Playoffs) ----------
  function renderStandingsGrid({ readOnly }) {
    return (
      <div className="groups-grid">
        {active.groups.map((group, gIndex) => {
          const { rows, compare } = computeStandings(group, byId, active.coinToss)
          const groupDone = group.matches.every((m) => m.status === 'completed')
          const groupQualifiers = active.groups.length === 1 ? group.playerIds.length : QUALIFIERS_PER_GROUP
          const cutlineTie =
            groupDone && rows.length > groupQualifiers && compare(rows[groupQualifiers - 1], rows[groupQualifiers]) === 0

          return (
            <article className="group-card" key={group.id}>
              <header className="group-head">
                <h3>{group.name}</h3>
                {!readOnly && <span className={`group-status ${groupDone ? 'is-done' : ''}`}>{groupDone ? 'Complete' : 'In play'}</span>}
              </header>

              <div className="standings-scroll">
                <table className="standings-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Player</th>
                      <th>P</th>
                      <th>W</th>
                      <th>L</th>
                      <th>PF</th>
                      <th>PA</th>
                      <th>+/-</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={r.id} className={i < groupQualifiers ? 'is-qualifying' : ''}>
                        <td>{i + 1}</td>
                        <td className="standings-name">
                          {r.name}
                          {liveCourtOf[r.id] != null && <span className="row-court-tag">Court {liveCourtOf[r.id]}</span>}
                        </td>
                        <td>{r.played}</td>
                        <td>{r.wins}</td>
                        <td>{r.losses}</td>
                        <td>{r.pf}</td>
                        <td>{r.pa}</td>
                        <td>{r.diff > 0 ? `+${r.diff}` : r.diff}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {!readOnly && cutlineTie && (
                <p className="cutline-warning">
                  Tie for the last qualifying spot. It's settled by wins, head-to-head, point difference, total points,
                  fewest points allowed, then coin toss — all of those are level, so check the scores or play a
                  tiebreaker before moving on.
                </p>
              )}

              {!readOnly && (
                <>
                  <h4 className="group-matches-label">Matches</h4>
                  <ul className="group-matches">
                    {group.matches.map((match, mIndex) => {
                      const key = `g-${gIndex}-${mIndex}`
                      const done = match.status === 'completed'
                      const live = match.status === 'live'
                      const info = infoByKey[key]

                      return (
                        <li className={`group-match ${done ? 'is-done' : ''} ${live ? 'is-live' : ''}`} key={match.id}>
                          <div className="group-match-teams">
                            {live && <span className="match-court-tag">Court {match.court}</span>}
                            {!done && !live && info && !info.playable && (
                              <span className="match-wait-tag">{info.blockers.map((p) => p.name).join(' & ')} on court</span>
                            )}
                            <div className={`group-match-row ${match.winnerId === match.aId ? 'is-winner' : ''}`}>
                              <span className="slot-name">{byId[match.aId]?.name ?? '—'}</span>
                              <input
                                className="t-score-input"
                                type="text"
                                inputMode="numeric"
                                placeholder="0"
                                value={match.scoreA}
                                disabled={done}
                                onChange={(e) => setGroupScore(gIndex, mIndex, 'A', e.target.value)}
                              />
                            </div>
                            <div className={`group-match-row ${match.winnerId === match.bId ? 'is-winner' : ''}`}>
                              <span className="slot-name">{byId[match.bId]?.name ?? '—'}</span>
                              <input
                                className="t-score-input"
                                type="text"
                                inputMode="numeric"
                                placeholder="0"
                                value={match.scoreB}
                                disabled={done}
                                onChange={(e) => setGroupScore(gIndex, mIndex, 'B', e.target.value)}
                              />
                            </div>
                          </div>

                          <div className="group-match-actions">
                            {done ? (
                              <button className="t-ghost-btn group-match-btn" onClick={() => editGroupMatch(gIndex, mIndex)}>
                                Edit result
                              </button>
                            ) : (
                              <>
                                {!live && info?.playable && freeCourts.length > 0 && (
                                  <button
                                    className="t-ghost-btn group-match-btn"
                                    onClick={() => startGroupMatch(gIndex, mIndex, freeCourts[0])}
                                  >
                                    Start · Court {freeCourts[0]}
                                  </button>
                                )}
                                <button
                                  className="btn-primary small group-match-btn"
                                  disabled={!canSubmit(match)}
                                  onClick={() => finishGroupMatch(gIndex, mIndex)}
                                >
                                  Submit
                                </button>
                                {live && (
                                  <button className="t-ghost-btn group-match-btn" onClick={() => stopGroupMatch(gIndex, mIndex)}>
                                    Unassign
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </>
              )}
            </article>
          )
        })}
      </div>
    )
  }

  return (
    <main className="tournament-page">
      {/* TOURNAMENT SELECTOR */}
      <section className="tournament-selector-bar">
        <div className="tournament-current">
          <span className="tournament-eyebrow">Tournament</span>
          <div className="tournament-picker">
            <select value={activeId} onChange={(e) => setActiveId(e.target.value)}>
              {tournaments.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({stageLabel[t.status] ?? t.status})
                </option>
              ))}
            </select>

            {editingTournamentName ? (
              <span className="tournament-rename-form">
                <input
                  type="text"
                  value={tournamentNameInput}
                  autoFocus
                  onChange={(e) => setTournamentNameInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveTournamentName()}
                />
                <button onClick={saveTournamentName}>Save</button>
                <button onClick={() => setEditingTournamentName(false)}>Cancel</button>
              </span>
            ) : (
              <div className="tournament-actions">
                <button
                  className="t-ghost-btn"
                  onClick={() => {
                    setTournamentNameInput(active.name)
                    setEditingTournamentName(true)
                  }}
                >
                  Rename
                </button>
                <button className="t-danger-btn" onClick={deleteActiveTournament}>
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="tournament-divider" />

        <form className="tournament-create-form" onSubmit={createNewTournament}>
          <input type="text" placeholder="New tournament name" value={newTournamentName} onChange={(e) => setNewTournamentName(e.target.value)} />
          <button type="submit" className="t-new-btn">
            + New Tournament
          </button>
        </form>
      </section>

      <section className="tournament-hero">
        <p className="eyebrow">Pool Play + Playoffs</p>
        <h1>{active.name}</h1>
        <p className="lede">
          Everyone plays their pool in a round robin. The top {QUALIFIERS_PER_GROUP} from each pool move on to a seeded
          single-elimination playoff (a single pool sends everyone). Once the qualifiers are known, if the number
          advancing is odd, the player with the best score advantage gets the standby bye and the rest play. The
          court board shows who's playing, free, or waiting, so courts never sit empty.
        </p>

        <ol className="stage-steps">
          {STAGES.map((stage, i) => (
            <li key={stage.key} className={i < stageIndex ? 'is-done' : i === stageIndex ? 'is-current' : ''}>
              <span className="stage-num">{i + 1}</span>
              <span className="stage-name">{stage.label}</span>
            </li>
          ))}
        </ol>
      </section>

      {/* ============ SETUP ============ */}
      {active.status === 'setup' && (
        <section className="tournament-setup">
          <div className="setup-col">
            <h2 className="t-heading">Participants</h2>
            <form className="add-participant-form" onSubmit={addParticipant}>
              <input type="text" placeholder="Player or team name" value={nameInput} onChange={(e) => setNameInput(e.target.value)} />
              <button type="submit" className="btn-primary">
                Add
              </button>
            </form>

            {participantCount === 0 ? (
              <p className="t-empty-note">No participants yet.</p>
            ) : (
              <ol className="participant-list">
                {active.participants.map((p, i) => (
                  <li key={p.id}>
                    <span className="position">{i + 1}</span>
                    {editingId === p.id ? (
                      <span className="edit-row">
                        <input
                          type="text"
                          value={editValue}
                          autoFocus
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit(p.id)
                            if (e.key === 'Escape') cancelEdit()
                          }}
                        />
                        <button onClick={() => saveEdit(p.id)}>Save</button>
                        <button onClick={cancelEdit}>Cancel</button>
                      </span>
                    ) : (
                      <>
                        <span className="player-name">{p.name}</span>
                        <span className="row-actions">
                          <button onClick={() => startEdit(p)}>Edit</button>
                          <button className="danger" onClick={() => removeParticipant(p.id)}>
                            Remove
                          </button>
                        </span>
                      </>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="setup-col">
            <h2 className="t-heading">Format</h2>
            <div className="bracket-preview-card">
              <div className="group-size-field">
                <label htmlFor="pool-count">Number of pools</label>
                <input
                  id="pool-count"
                  type="text"
                  inputMode="numeric"
                  className="pool-count-input"
                  value={poolCountDraft}
                  disabled={participantCount < MIN_PARTICIPANTS}
                  onChange={(e) => handlePoolCountChange(e.target.value)}
                  onBlur={handlePoolCountBlur}
                  onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
                />
              </div>
              {participantCount >= MIN_PARTICIPANTS && (
                <p className={`pool-count-hint ${poolCountTooHigh || poolCountZero ? 'is-invalid' : ''}`}>
                  {poolCountTooHigh || poolCountZero
                    ? `Choose between 1 and ${maxPools} pools for ${participantCount} players (at least ${MIN_POOL_SIZE} per pool).`
                    : `Type any number from 1 to ${maxPools}. It applies as you type.`}
                </p>
              )}

              {active.poolSizes.length > 0 && (
                <div className="pool-config">
                  <div className="pool-config-head">
                    <p className="pool-config-title">Players per pool</p>
                    <button className="t-link-btn" onClick={balancePools}>
                      Even split
                    </button>
                  </div>
                  <ul className="pool-config-list">
                    {active.poolSizes.map((_, i) => (
                      <li className="pool-config-row" key={i}>
                        <span>Pool {String.fromCharCode(65 + i)}</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={poolSizeDrafts[i] ?? ''}
                          onChange={(e) => handlePoolSizeChange(i, e.target.value)}
                          onBlur={() => handlePoolSizeBlur(i)}
                          onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
                        />
                      </li>
                    ))}
                  </ul>
                  <p className={`pool-config-total ${poolTotalValid ? 'is-valid' : 'is-invalid'}`}>
                    Total: {poolTotal} / {participantCount} {poolTotalValid ? '✓' : '✗'}
                  </p>
                  {!allPoolsMinSize && (
                    <p className="pool-config-total is-invalid">Every pool needs at least {MIN_POOL_SIZE} players.</p>
                  )}
                </div>
              )}

              <div className="group-size-field">
                <label htmlFor="court-count">Courts available</label>
                <select id="court-count" value={active.courtCount} onChange={(e) => setCourtCount(e.target.value)}>
                  {range(MAX_COURTS).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>

              <p>
                <strong>{participantCount}</strong> participant{participantCount === 1 ? '' : 's'}
              </p>

              {active.poolSizes.length > 0 ? (
                <>
                  <p>
                    {singlePoolFormat ? (
                      <>
                        One pool — <strong>all {previewQualifiers}</strong> advance to the bracket.
                      </>
                    ) : (
                      <>
                        Top <strong>{QUALIFIERS_PER_GROUP}</strong> per pool advance: <strong>{previewQualifiers}</strong> qualifiers.
                      </>
                    )}
                  </p>
                  <p>
                    Playoffs: <strong>{previewShape.rounds}</strong> round{previewShape.rounds === 1 ? '' : 's'}.{' '}
                    {singlePoolFormat ? 'Everyone is seeded by pool standings.' : "Round 1 has every qualifier playing (pool winners vs other pools' runners-up)."}
                  </p>
                  <p>
                    Standby: <strong>{previewShape.byes === 0 ? 'none' : `${previewShape.byes} (never more than 1 team at a time)`}</strong>
                  </p>
                  <p className="rules-note">
                    When the advancing players are odd, the best score advantage gets the standby: win rate over all
                    matches, then head-to-head, point differential, total points, fewest points allowed, coin toss.
                  </p>
                </>
              ) : (
                <p className="t-empty-note">Add at least {MIN_PARTICIPANTS} participants to start.</p>
              )}

              <button className="btn-primary" disabled={!canGeneratePools} onClick={startGroupStage}>
                Generate Pools &amp; Start
              </button>
            </div>
          </div>
        </section>
      )}

      {/* ============ POOL PLAY ============ */}
      {active.status === 'groups' && (
        <section className="tournament-groups-section" id="groups">
          <div className="group-toolbar">
            <div className="group-progress">
              <span className="group-progress-label">
                {playedGroupMatches} of {allGroupMatches.length} pool matches played
              </span>
              <span className="group-progress-track">
                <span
                  className="group-progress-fill"
                  style={{ width: `${allGroupMatches.length ? (playedGroupMatches / allGroupMatches.length) * 100 : 0}%` }}
                />
              </span>
            </div>

            <div className="bracket-toolbar">
              <button className="t-ghost-btn" onClick={editParticipants}>
                Edit participants
              </button>
              <button className="t-danger-btn" onClick={endTournament}>
                End tournament
              </button>
            </div>
          </div>

          {renderCourtBoard()}
          {renderStandingsGrid({ readOnly: false })}

          <div className="knockout-cta">
            <p>
              {groupStageDone
                ? active.groups.length === 1
                  ? 'Pool play complete. Everyone advances, seeded by standings.'
                  : 'Pool play complete. The top 2 from each pool are ready for the playoffs.'
                : 'Finish every pool match to unlock the playoff bracket.'}
            </p>
            <button className="btn-primary" disabled={!groupStageDone} onClick={startKnockout}>
              Start Playoffs
            </button>
          </div>
        </section>
      )}

      {/* ============ PLAYOFF BRACKET ============ */}
      {active.status === 'bracket' && (
        <section className="tournament-bracket-section" id="bracket">
          {champion && (
            <div className="champion-banner">
              <span className="champion-crown">🏆</span>
              <span className="champion-label">Champion</span>
              <span className="champion-name">{champion.name}</span>
            </div>
          )}

          <div className="bracket-toolbar">
            {active.groups.length > 0 && (
              <button className="t-ghost-btn" onClick={backToGroups}>
                Back to pool play
              </button>
            )}
            <button className="t-ghost-btn" onClick={editParticipants}>
              Edit participants
            </button>
            <button className="t-danger-btn" onClick={endTournament}>
              End tournament
            </button>
          </div>

          <h2 className="t-heading">Pool standings</h2>
          {renderStandingsGrid({ readOnly: true })}

          {renderCourtBoard()}

          <div className="bracket-scroll">
            <div className="bracket-rounds">
              {active.rounds.map((round, rIndex) => (
                <div className="bracket-round" key={rIndex}>
                  <h3 className="round-label">{round.label}</h3>
                  <div className="round-matches">
                    {round.standby && (
                      <div className="bracket-match status-completed">
                        <div className="bye-row">
                          <span className="seed-tag">{round.standby.tag}</span>
                          <span className="winner-name">{round.standby.name}</span>
                          <span className="bye-tag">STANDBY</span>
                        </div>
                        {round.standbyNote && <p className="bye-note">{round.standbyNote}</p>}
                      </div>
                    )}
                    {round.matches.map((match, mIndex) => {
                      const key = `b-${rIndex}-${mIndex}`
                      const info = infoByKey[key]
                      const live = match.status === 'live'

                      return (
                        <div className={`bracket-match status-${match.status}`} key={mIndex}>
                          {live && <span className="match-court-tag">Court {match.court}</span>}
                          {match.status === 'ready' && info && !info.playable && (
                            <span className="match-wait-tag">{info.blockers.map((p) => p.name).join(' & ')} on court</span>
                          )}

                          <div className={`match-row ${match.winnerId === match.playerA.id ? 'is-winner' : ''}`}>
                            <span className="seed-tag" title={`Seed ${match.playerA.seed}`}>
                              {match.playerA.tag}
                            </span>
                            <span className="slot-name">{nameFor(match.playerA)}</span>
                            <input
                              className="t-score-input"
                              type="text"
                              inputMode="numeric"
                              placeholder="0"
                              value={match.scoreA}
                              disabled={match.status === 'completed'}
                              onChange={(e) => setScore(rIndex, mIndex, 'A', e.target.value)}
                            />
                          </div>
                          <div className={`match-row ${match.winnerId === match.playerB.id ? 'is-winner' : ''}`}>
                            <span className="seed-tag" title={`Seed ${match.playerB.seed}`}>
                              {match.playerB.tag}
                            </span>
                            <span className="slot-name">{nameFor(match.playerB)}</span>
                            <input
                              className="t-score-input"
                              type="text"
                              inputMode="numeric"
                              placeholder="0"
                              value={match.scoreB}
                              disabled={match.status === 'completed'}
                              onChange={(e) => setScore(rIndex, mIndex, 'B', e.target.value)}
                            />
                          </div>

                          {(match.status === 'ready' || live) && (
                            <div className="bracket-match-actions">
                              {!live && info?.playable && freeCourts.length > 0 && (
                                <button className="t-ghost-btn match-edit" onClick={() => startBracketMatch(rIndex, mIndex, freeCourts[0])}>
                                  Start · Court {freeCourts[0]}
                                </button>
                              )}
                              <button
                                className="btn-primary small match-submit"
                                disabled={!canSubmit(match)}
                                onClick={() => finishMatch(rIndex, mIndex)}
                              >
                                Submit
                              </button>
                            </div>
                          )}
                          {match.status === 'completed' && (
                            <button className="t-ghost-btn match-edit" onClick={() => editMatch(rIndex, mIndex)}>
                              Edit result
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </main>
  )
}

export default Tournament