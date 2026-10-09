// Join (or quietly resume) a live session.
// The join form uses it with typed-in details; the play/lobby screens use it
// with what is already saved so a refresh or a dropped connection lands the
// student back in the same seat with their score and progress intact.
import { emitAck } from '../net.js';
import { store, save } from '../state.js';
import { LiveEngine } from './liveEngine.js';
import { setActiveGame, clearActive } from './session.js';

export async function enterSession({ code, nickname, team = '', playerId } = {}) {
  const res = await emitAck('player:join', {
    code,
    nickname,
    team: team || undefined,
    playerId: playerId || store.playerId || undefined,
  }, 8000);
  if (!res || res.error || !res.ok) throw new Error(res?.error || 'Could not join this session.');

  save({ code, nickname, team, playerId: res.playerId });

  const engine = new LiveEngine({ code, playerId: res.playerId });
  engine.attach();
  clearActive();
  setActiveGame(engine, {
    mode: 'live', code, teamMode: res.teamMode, started: res.started, title: res.title,
    // question timer contract from the join ack (question:start refines it live)
    timerOn: res.timerOn, selfPaced: res.selfPaced,
    allowBack: res.allowBack, allowSkip: res.allowSkip, quizEndsAt: res.quizEndsAt,
    // fixed-marks scoring contract (power-up costs + labels on the card)
    marks: res.marks, costs: res.costs,
    negativeMarking: res.negativeMarking, negativeAmount: res.negativeAmount,
  });
  return res;
}
