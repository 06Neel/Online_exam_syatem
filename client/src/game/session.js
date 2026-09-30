// Holds the active game engine (practice or live) while screens change.
let active = null;

export function setActiveGame(engine, meta = {}) {
  active = { engine, meta };
  return active;
}

export function getActive() {
  return active;
}

export function clearActive() {
  const prev = active;
  active = null;
  return prev;
}
