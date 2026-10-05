import { useState, useRef, useEffect } from 'react'
import '../css/OpenPlayQueue.css'

const STORAGE_KEY = 'dilaab-open-play-multi-state'

function createInitialSession(id, name = 'Open Play 1') {
  return {
    id,
    name,
    players: [],
    courts: [
      { id: 1, label: 'Court 1', match: null },
    ],
    matchHistory: {},
    partnerHistory: {},
    matchLog: [],
    idCounter: 2,
  }
}

function loadSavedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ---------- helpers ----------

function pairKey(aId, bId) {
  return [aId, bId].sort((x, y) => x - y).join('-')
}

function combinations(arr, k) {
  const result = []
  const combo = []
  function backtrack(start) {
    if (combo.length === k) {
      result.push([...combo])
      return
    }
    for (let i = start; i < arr.length; i += 1) {
      combo.push(arr[i])
      backtrack(i + 1)
      combo.pop()
    }
  }
  backtrack(0)
  return result
}

function groupRepeatScore(group, matchHistory) {
  let score = 0
  for (let i = 0; i < group.length; i += 1) {
    for (let j = i + 1; j < group.length; j += 1) {
      score += matchHistory[pairKey(group[i].id, group[j].id)] || 0
    }
  }
  return score
}

function pickNextGroup(queue, matchHistory) {
  const windowSize = Math.min(queue.length, 8)
  const pool = queue.slice(0, windowSize)
  const combos = combinations(pool, 4)

  let best = null
  combos.forEach((group) => {
    const repeatScore = groupRepeatScore(group, matchHistory)
    const maxIndex = Math.max(...group.map((p) => pool.indexOf(p)))
    const skippedCount = pool
      .slice(0, maxIndex + 1)
      .filter((p) => !group.includes(p)).length
    const score = repeatScore * 10 + skippedCount
    if (!best || score < best.score) {
      best = { group, score }
    }
  })

  return best.group
}

function splitIntoTeams(group, partnerHistory) {
  const [a, b, c, d] = group
  const options = [
    { teamA: [a, b], teamB: [c, d] },
    { teamA: [a, c], teamB: [b, d] },
    { teamA: [a, d], teamB: [b, c] },
  ]

  let best = null
  options.forEach((option) => {
    const penalty =
      (partnerHistory[pairKey(option.teamA[0].id, option.teamA[1].id)] || 0) +
      (partnerHistory[pairKey(option.teamB[0].id, option.teamB[1].id)] || 0)
    if (!best || penalty < best.penalty) {
      best = { option, penalty }
    }
  })

  return best.option
}

// ---------- component ----------

function OpenPlayQueue() {
  const [saved] = useState(() => loadSavedState())

  const [sessions, setSessions] = useState(() => {
    if (saved?.sessions && saved.sessions.length > 0) return saved.sessions
    return [createInitialSession('session-1', 'OPEN PLAY')]
  })

  const [activeSessionId, setActiveSessionId] = useState(
    () => saved?.activeSessionId || 'session-1'
  )

  const sessionCounterRef = useRef(saved?.sessionCounter ?? 2)

  const [newSessionName, setNewSessionName] = useState('')
  const [editingSessionName, setEditingSessionName] = useState(false)
  const [sessionLabelInput, setSessionLabelInput] = useState('')

  const [nameInput, setNameInput] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [customDrafts, setCustomDrafts] = useState({})

  const activeSession =
    sessions.find((s) => s.id === activeSessionId) || sessions[0]

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          sessions,
          activeSessionId,
          sessionCounter: sessionCounterRef.current,
        })
      )
    } catch (err) {
      console.error('Could not save Open Play state:', err)
    }
  }, [sessions, activeSessionId])

  function updateActiveSession(updater) {
    setSessions((prevSessions) =>
      prevSessions.map((session) =>
        session.id === activeSession.id ? updater(session) : session
      )
    )
  }

  function nextPlayerOrCourtId() {
    const newId = activeSession.idCounter + 1
    updateActiveSession((s) => ({ ...s, idCounter: newId }))
    return newId
  }

  function createSession(e) {
    e.preventDefault()
    const name = newSessionName.trim() || `NOVICE ${sessionCounterRef.current}`
    const newId = `session-${Date.now()}`
    const newSession = createInitialSession(newId, name)

    sessionCounterRef.current += 1
    setSessions((prev) => [...prev, newSession])
    setActiveSessionId(newId)
    setNewSessionName('')
  }

  function deleteActiveSession() {
    if (sessions.length <= 1) {
      alert('You must have at least one active Open Play session.')
      return
    }
    const confirmed = window.confirm(
      `Delete "${activeSession.name}"? All queues and match logs for this session will be permanently lost.`
    )
    if (!confirmed) return

    const remaining = sessions.filter((s) => s.id !== activeSession.id)
    setSessions(remaining)
    setActiveSessionId(remaining[0].id)
  }

  function saveSessionLabel() {
    const trimmed = sessionLabelInput.trim()
    if (trimmed) {
      updateActiveSession((s) => ({ ...s, name: trimmed }))
    }
    setEditingSessionName(false)
  }

  const players = activeSession.players
  const courts = activeSession.courts
  const matchHistory = activeSession.matchHistory
  const partnerHistory = activeSession.partnerHistory
  const matchLog = activeSession.matchLog

  const waiting = players
    .filter((p) => p.status === 'waiting')
    .sort((a, b) => a.queuedAt - b.queuedAt)
  const benched = players.filter((p) => p.status === 'benched')

  useEffect(() => {
    setCustomDrafts((prevDrafts) => {
      // must live INSIDE the updater: React StrictMode runs updaters twice,
      // and a mutated outer variable made the 2nd run delete the draft
      let remaining = [...waiting]
      const nextDrafts = { ...prevDrafts }

      courts.forEach((court) => {
        if (court.match) {
          delete nextDrafts[court.id]
          return
        }

        const currentDraft = nextDrafts[court.id]
        const draftIds = currentDraft
          ? [...currentDraft.teamA, ...currentDraft.teamB]
          : []
        const isDraftValid =
          draftIds.length === 4 &&
          draftIds.every((id) => remaining.some((p) => p.id === id))

        if (!isDraftValid) {
          if (remaining.length >= 4) {
            const group = pickNextGroup(remaining, matchHistory)
            const teams = splitIntoTeams(group, partnerHistory)
            nextDrafts[court.id] = {
              teamA: teams.teamA.map((p) => p.id),
              teamB: teams.teamB.map((p) => p.id),
            }
            remaining = remaining.filter((p) => !group.includes(p))
          } else {
            delete nextDrafts[court.id]
          }
        } else {
          remaining = remaining.filter((p) => !draftIds.includes(p.id))
        }
      })

      return nextDrafts
    })
  }, [courts, players, matchHistory, partnerHistory, activeSessionId])

  function addPlayer(e) {
    e.preventDefault()
    const name = nameInput.trim()
    if (!name) return

    const newId = nextPlayerOrCourtId()
    updateActiveSession((s) => ({
      ...s,
      players: [
        ...s.players,
        {
          id: newId,
          name,
          status: 'waiting',
          queuedAt: Date.now(),
          wins: 0,
          losses: 0,
          gamesPlayed: 0,
        },
      ],
    }))
    setNameInput('')
  }

  function removePlayer(id) {
    updateActiveSession((s) => ({
      ...s,
      players: s.players.filter((p) => p.id !== id),
    }))
    if (editingId === id) setEditingId(null)
  }

  function startEdit(player) {
    setEditingId(player.id)
    setEditValue(player.name)
  }

  function cancelEdit() {
    setEditingId(null)
    setEditValue('')
  }

  function saveEdit(id) {
    const trimmed = editValue.trim()
    if (trimmed) {
      updateActiveSession((s) => ({
        ...s,
        players: s.players.map((p) => (p.id === id ? { ...p, name: trimmed } : p)),
      }))
    }
    setEditingId(null)
    setEditValue('')
  }

  function benchPlayer(id) {
    updateActiveSession((s) => ({
      ...s,
      players: s.players.map((p) => (p.id === id ? { ...p, status: 'benched' } : p)),
    }))
  }

  function unbenchPlayer(id) {
    updateActiveSession((s) => ({
      ...s,
      players: s.players.map((p) =>
        p.id === id ? { ...p, status: 'waiting', queuedAt: Date.now() } : p
      ),
    }))
  }

  function addCourt() {
    const newId = nextPlayerOrCourtId()
    updateActiveSession((s) => ({
      ...s,
      courts: [
        ...s.courts,
        { id: newId, label: `Court ${s.courts.length + 1}`, match: null },
      ],
    }))
  }

  function removeCourt(id) {
    updateActiveSession((s) => {
      const court = s.courts.find((c) => c.id === id)
      if (court?.match) return s
      return { ...s, courts: s.courts.filter((c) => c.id !== id) }
    })
  }

  function endOpenPlay() {
    const confirmed = window.confirm(
      `End season for "${activeSession.name}"? This will reset all scores and records for this session.`
    )
    if (!confirmed) return

    updateActiveSession((s) => ({
      ...s,
      players: [],
      courts: [
        { id: 1, label: 'Court 1', match: null },
      ],
      matchHistory: {},
      partnerHistory: {},
      matchLog: [],
      idCounter: 2,
    }))

    setNameInput('')
    setEditingId(null)
    setEditValue('')
    setCustomDrafts({})
  }

  function swapDraftPlayer(courtId, team, index, newPlayerId) {
    setCustomDrafts((prev) => {
      const courtDraft = prev[courtId]
      if (!courtDraft) return prev

      const updatedTeam = [...courtDraft[team]]
      updatedTeam[index] = Number(newPlayerId)

      return {
        ...prev,
        [courtId]: { ...courtDraft, [team]: updatedTeam },
      }
    })
  }

  function startDraftMatch(courtId) {
    const draft = customDrafts[courtId]
    if (!draft) return

    const selectedIds = [...draft.teamA, ...draft.teamB]
    const hasDuplicates = new Set(selectedIds).size !== selectedIds.length

    if (hasDuplicates) {
      alert('A player cannot be selected twice in the same match!')
      return
    }

    updateActiveSession((s) => ({
      ...s,
      courts: s.courts.map((c) =>
        c.id === courtId
          ? {
              ...c,
              match: {
                teamA: draft.teamA,
                teamB: draft.teamB,
                scoreA: '',
                scoreB: '',
              },
            }
          : c
      ),
      players: s.players.map((p) =>
        selectedIds.includes(p.id) ? { ...p, status: 'playing' } : p
      ),
    }))
  }

  function setScore(courtId, team, value) {
    if (value !== '' && !/^\d{0,2}$/.test(value)) return
    updateActiveSession((s) => ({
      ...s,
      courts: s.courts.map((c) =>
        c.id === courtId
          ? {
              ...c,
              match: {
                ...c.match,
                [team === 'A' ? 'scoreA' : 'scoreB']: value,
              },
            }
          : c
      ),
    }))
  }

  function finishMatchWithScore(courtId) {
    const court = courts.find((c) => c.id === courtId)
    if (!court?.match) return
    const scoreA = Number(court.match.scoreA)
    const scoreB = Number(court.match.scoreB)
    if (court.match.scoreA === '' || court.match.scoreB === '' || scoreA === scoreB) {
      return
    }
    finishMatch(courtId, scoreA > scoreB ? 'A' : 'B', { scoreA, scoreB })
  }

  function finishMatch(courtId, winner, score = null) {
    const court = courts.find((c) => c.id === courtId)
    if (!court?.match) return
    const { teamA, teamB } = court.match
    const allIds = [...teamA, ...teamB]

    updateActiveSession((s) => {
      const nextMatchHistory = { ...s.matchHistory }
      for (let i = 0; i < allIds.length; i += 1) {
        for (let j = i + 1; j < allIds.length; j += 1) {
          const key = pairKey(allIds[i], allIds[j])
          nextMatchHistory[key] = (nextMatchHistory[key] || 0) + 1
        }
      }

      const nextPartnerHistory = { ...s.partnerHistory }
      const keyA = pairKey(teamA[0], teamA[1])
      const keyB = pairKey(teamB[0], teamB[1])
      nextPartnerHistory[keyA] = (nextPartnerHistory[keyA] || 0) + 1
      nextPartnerHistory[keyB] = (nextPartnerHistory[keyB] || 0) + 1

      const updatedPlayers = s.players.map((p) => {
        if (!allIds.includes(p.id)) return p
        const won = winner === 'A' ? teamA.includes(p.id) : teamB.includes(p.id)
        return {
          ...p,
          status: 'waiting',
          queuedAt: Date.now(),
          gamesPlayed: p.gamesPlayed + 1,
          wins: winner ? p.wins + (won ? 1 : 0) : p.wins,
          losses: winner ? p.losses + (won ? 0 : 1) : p.losses,
        }
      })

      const logEntry = {
        id: Date.now(),
        teamA: teamA.map((id) => nameFor(id)),
        teamB: teamB.map((id) => nameFor(id)),
        scoreA: score?.scoreA ?? null,
        scoreB: score?.scoreB ?? null,
        winner,
        court: court.label,
        finishedAt: Date.now(),
      }

      return {
        ...s,
        matchHistory: nextMatchHistory,
        partnerHistory: nextPartnerHistory,
        players: updatedPlayers,
        courts: s.courts.map((c) => (c.id === courtId ? { ...c, match: null } : c)),
        matchLog: [logEntry, ...s.matchLog].slice(0, 15),
      }
    })
  }

  function nameFor(id) {
    return players.find((p) => p.id === id)?.name || '—'
  }

  const upNextIds = new Set(
    Object.values(customDrafts).flatMap((draft) =>
      draft ? [...draft.teamA, ...draft.teamB] : []
    )
  )

  // players already placed in another court's draft
  const freePlayers = waiting.length - upNextIds.size
  const playersNeeded = Math.max(0, 4 - freePlayers)

  const leaderboard = [...players].sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins
    const aRate = a.gamesPlayed ? a.wins / a.gamesPlayed : 0
    const bRate = b.gamesPlayed ? b.wins / b.gamesPlayed : 0
    return bRate - aRate
  })

  const liveCourts = courts.filter((c) => c.match).length

  return (
    <main className="queue-page">
      {/* SESSION BAR */}
      <section className="session-bar">
        <div className="session-bar-main">
          <div className="session-field">
            <label htmlFor="session-select" className="session-label">
              Open Play Session
            </label>
            <div className="session-select-wrap">
              <select
                id="session-select"
                value={activeSessionId}
                onChange={(e) => {
                  setActiveSessionId(e.target.value)
                  setCustomDrafts({})
                }}
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <span className="session-meta">
              {players.length} player{players.length !== 1 ? 's' : ''} ·{' '}
              {liveCourts} of {courts.length} courts live
            </span>
          </div>

          <div className="session-actions">
            {editingSessionName ? (
              <form
                className="session-rename"
                onSubmit={(e) => {
                  e.preventDefault()
                  saveSessionLabel()
                }}
              >
                <input
                  type="text"
                  value={sessionLabelInput}
                  onChange={(e) => setSessionLabelInput(e.target.value)}
                  autoFocus
                />
                <button
                  type="submit"
                  className="session-btn session-btn--primary"
                >
                  Save
                </button>
                <button
                  type="button"
                  className="session-btn"
                  onClick={() => setEditingSessionName(false)}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <button
                  type="button"
                  className="session-btn"
                  onClick={() => {
                    setSessionLabelInput(activeSession.name)
                    setEditingSessionName(true)
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="session-btn session-btn--danger"
                  onClick={deleteActiveSession}
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </div>

        <form className="session-create" onSubmit={createSession}>
          <input
            type="text"
            placeholder="New session name (e.g. Intermediate / Sunday)"
            value={newSessionName}
            onChange={(e) => setNewSessionName(e.target.value)}
          />
          <button type="submit" className="session-btn session-btn--primary">
            + New Open Play
          </button>
        </form>
      </section>

      <section className="queue-hero">
        <p className="eyebrow">Open Play Session</p>
        <h1>{activeSession.name}</h1>
        <p className="lede">
          Add players as they show up, send them to a court, and the matchmaker
          spreads partners and opponents out so the same two people aren't paired
          over and over.
        </p>
      </section>

      <section className="queue-grid">
        <div className="queue-col">
          <h2 className="queue-heading">Queue</h2>
          <form className="add-player-form" onSubmit={addPlayer}>
            <input
              type="text"
              placeholder="Player name"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
            />
            <button type="submit" className="btn-primary">
              Add
            </button>
          </form>

          {waiting.length === 0 ? (
            <p className="empty-note">No one waiting yet.</p>
          ) : (
            <ol className="player-list">
              {waiting.map((p, i) => (
                <li
                  key={p.id}
                  className={upNextIds.has(p.id) ? 'is-up-next' : ''}
                >
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
                      <span className="player-name">
                        {p.name}
                        {upNextIds.has(p.id) && (
                          <span className="up-next-tag">NEXT</span>
                        )}
                      </span>
                      <span className="player-actions">
                        <button onClick={() => startEdit(p)}>Edit</button>
                        <button onClick={() => benchPlayer(p.id)}>Bench</button>
                        <button
                          className="danger"
                          onClick={() => removePlayer(p.id)}
                        >
                          Remove
                        </button>
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ol>
          )}

          <h3 className="sub-heading">Benched</h3>
          {benched.length === 0 ? (
            <p className="empty-note">Nobody on the bench.</p>
          ) : (
            <ul className="player-list benched-list">
              {benched.map((p) => (
                <li key={p.id}>
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
                      <span className="player-actions">
                        <button onClick={() => startEdit(p)}>Edit</button>
                        <button onClick={() => unbenchPlayer(p.id)}>
                          Return to queue
                        </button>
                        <button
                          className="danger"
                          onClick={() => removePlayer(p.id)}
                        >
                          Remove
                        </button>
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="queue-col">
          <div className="courts-heading-row">
            <h2 className="queue-heading">Courts</h2>
            <button className="btn-ghost small" onClick={addCourt}>
              + Add court
            </button>
          </div>

          <div className="courts-list">
            {courts.map((court) => (
              <div className="court-card" key={court.id}>
                <div className="court-card-head">
                  <span className="court-title">
                    {court.label}
                    {court.match && (
                      <span className="live-badge">
                        <span className="live-dot" /> LIVE
                      </span>
                    )}
                  </span>
                  {!court.match && courts.length > 1 && (
                    <button
                      className="link-btn"
                      onClick={() => removeCourt(court.id)}
                    >
                      Remove
                    </button>
                  )}
                </div>

                {court.match ? (
                  <div className="match-view">
                    <div className="match-team">
                      <span className="team-label">Team A</span>
                      <span>{nameFor(court.match.teamA[0])}</span>
                      <span>{nameFor(court.match.teamA[1])}</span>
                      <input
                        className="score-input"
                        type="text"
                        inputMode="numeric"
                        placeholder="0"
                        value={court.match.scoreA}
                        onChange={(e) =>
                          setScore(court.id, 'A', e.target.value)
                        }
                      />
                    </div>
                    <div className="match-vs">vs</div>
                    <div className="match-team">
                      <span className="team-label">Team B</span>
                      <span>{nameFor(court.match.teamB[0])}</span>
                      <span>{nameFor(court.match.teamB[1])}</span>
                      <input
                        className="score-input"
                        type="text"
                        inputMode="numeric"
                        placeholder="0"
                        value={court.match.scoreB}
                        onChange={(e) =>
                          setScore(court.id, 'B', e.target.value)
                        }
                      />
                    </div>
                    <div className="match-actions">
                      <button
                        className="btn-primary small"
                        disabled={
                          court.match.scoreA === '' ||
                          court.match.scoreB === '' ||
                          court.match.scoreA === court.match.scoreB
                        }
                        onClick={() => finishMatchWithScore(court.id)}
                      >
                        Finish match
                      </button>
                    </div>
                  </div>
                ) : customDrafts[court.id] ? (
                  <div className="customizer-view">
                    <div className="customizer-teams">
                      <div className="customizer-team">
                        <span className="team-label">Team A</span>
                        {customDrafts[court.id].teamA.map((pId, idx) => (
                          <select
                            key={`teamA-${idx}`}
                            value={pId}
                            onChange={(e) =>
                              swapDraftPlayer(
                                court.id,
                                'teamA',
                                idx,
                                e.target.value
                              )
                            }
                          >
                            {waiting.map((wp) => (
                              <option key={wp.id} value={wp.id}>
                                {wp.name}
                              </option>
                            ))}
                          </select>
                        ))}
                      </div>

                      <div className="match-vs">vs</div>

                      <div className="customizer-team">
                        <span className="team-label">Team B</span>
                        {customDrafts[court.id].teamB.map((pId, idx) => (
                          <select
                            key={`teamB-${idx}`}
                            value={pId}
                            onChange={(e) =>
                              swapDraftPlayer(
                                court.id,
                                'teamB',
                                idx,
                                e.target.value
                              )
                            }
                          >
                            {waiting.map((wp) => (
                              <option key={wp.id} value={wp.id}>
                                {wp.name}
                              </option>
                            ))}
                          </select>
                        ))}
                      </div>
                    </div>

                    <div className="customizer-actions">
                      <button
                        className="btn-primary small"
                        onClick={() => startDraftMatch(court.id)}
                      >
                        Start Game
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="court-empty">
                    <p>
                      Need {playersNeeded} more player
                      {playersNeeded !== 1 ? 's' : ''} in queue
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {matchLog.length > 0 && (
        <section className="recent-section">
          <h2 className="queue-heading">Recent matches</h2>
          <ul className="recent-list">
            {matchLog.map((m) => (
              <li key={m.id}>
                <span className="recent-court">{m.court}</span>
                <span
                  className={`recent-team ${m.winner === 'A' ? 'is-winner' : ''}`}
                >
                  {m.teamA.join(' & ')}
                </span>
                <span className="recent-score">
                  {m.scoreA !== null ? `${m.scoreA} – ${m.scoreB}` : 'vs'}
                </span>
                <span
                  className={`recent-team ${m.winner === 'B' ? 'is-winner' : ''}`}
                >
                  {m.teamB.join(' & ')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="leaderboard-section" id="leaderboard">
        <div className="season-header">
          <div>
            <p className="eyebrow">{activeSession.name}</p>
            <h2 className="queue-heading">Final Rankings</h2>
          </div>
        </div>

        {leaderboard.length === 0 ? (
          <p className="empty-note">Add players and play a few matches.</p>
        ) : (
          <>
            <div className="podium-section">
              {leaderboard.slice(0, 3).map((player, index) => {
                const rank = index + 1
                const winRate = player.gamesPlayed
                  ? Math.round((player.wins / player.gamesPlayed) * 100)
                  : 0

                return (
                  <div
                    key={player.id}
                    className={`podium-player podium-${rank}`}
                  >
                    <div className="podium-player-info">
                      <span className="podium-rank">TOP {rank}</span>
                      <span className="podium-name">{player.name}</span>
                      <span className="podium-record">
                        {player.wins} W · {winRate}% WIN RATE
                      </span>
                    </div>

                    <div className="podium-bar">
                      <span className="podium-number">{rank}</span>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="leaderboard-full">
              <h3 className="sub-heading">Season Standings</h3>

              <div className="table-scroll">
                <table className="leaderboard-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Player</th>
                      <th>Played</th>
                      <th>W</th>
                      <th>L</th>
                      <th>Win %</th>
                    </tr>
                  </thead>

                  <tbody>
                    {leaderboard.map((p, i) => (
                      <tr key={p.id}>
                        <td>{i + 1}</td>
                        <td>{p.name}</td>
                        <td>{p.gamesPlayed}</td>
                        <td>{p.wins}</td>
                        <td>{p.losses}</td>
                        <td>
                          {p.gamesPlayed
                            ? `${Math.round((p.wins / p.gamesPlayed) * 100)}%`
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="end-season">
              <p className="end-season-title">Reset Session Data?</p>
              <p className="end-season-note">
                End session to clear queues, history, and scores for "{activeSession.name}".
              </p>

              <button className="end-open-play-btn" onClick={endOpenPlay}>
                End Open Play Session
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  )
}

export default OpenPlayQueue