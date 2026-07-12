/*
 * time.js — Game.Time: the game clock.
 * Owns: tick, minuteOfDay, day, dayOfSeason, season, year, weather.
 * step(minutes) advances the clock and, on each day rollover, rolls weather
 * then emits 'day:advance' (and 'season:change'/'weather:change'). ALL heavy
 * simulation lives in day:advance handlers (see dailyTick order), so advancing
 * many days at once (fast-forward / test.advanceDays) is exact and deterministic.
 */
Game.Time = (function () {
  'use strict';
  var U = Game.Util, D = Game.DATA, K = Game.DATA.const;
  var bus = Game.bus;

  function clock() {
    var s = Game.state;
    return { minuteOfDay: s.minuteOfDay, day: s.day, dayOfSeason: s.dayOfSeason, season: s.season, year: s.year, weather: s.weather };
  }

  function phaseAt(minuteOfDay) {
    var t = (minuteOfDay % 1440) / 1440;
    var P = K.PHASES;
    if (t < P.morning[1]) return 'morning';
    if (t < P.day[1]) return 'day';
    if (t < P.evening[1]) return 'evening';
    return 'night';
  }
  function isNight() { return phaseAt(Game.state.minuteOfDay) === 'night'; }

  // Smooth 0..1 light level interpolated across phase ambient values.
  function lightLevel() {
    var s = Game.state, amb = K.AMBIENT_LIGHT;
    var t = (s.minuteOfDay % 1440) / 1440;
    // control points (fraction -> light)
    var pts = [
      [0.00, amb.night], [0.03, amb.night], [0.10, amb.morning], [0.25, amb.day],
      [0.55, amb.day], [0.66, amb.evening], [0.83, amb.night], [1.00, amb.night]
    ];
    for (var i = 0; i < pts.length - 1; i++) {
      if (t >= pts[i][0] && t <= pts[i + 1][0]) {
        var f = U.invLerp(pts[i][0], pts[i + 1][0], t);
        return U.lerp(pts[i][1], pts[i + 1][1], f);
      }
    }
    return amb.day;
  }

  function rollWeather() {
    var s = Game.state;
    var odds = (D.weatherModel && D.weatherModel.oddsBySeason && D.weatherModel.oddsBySeason[s.season]) || { sunny: 1 };
    var r = U.rng(), acc = 0, chosen = 'sunny';
    var keys = Object.keys(odds);
    for (var i = 0; i < keys.length; i++) { acc += odds[keys[i]]; if (r <= acc) { chosen = keys[i]; break; } }
    return chosen;
  }
  function setWeather(w) {
    var s = Game.state, prev = s.weather;
    s.weather = w;
    if (w !== prev) bus.emit('weather:change', { weather: w, prev: prev });
  }

  function advanceDay() {
    var s = Game.state;
    s.day += 1;
    s.dayOfSeason += 1;
    var seasonChanged = false;
    if (s.dayOfSeason > K.DAYS_PER_SEASON) {
      s.dayOfSeason = 1;
      var order = K.SEASON_ORDER;
      var idx = order.indexOf(s.season);
      idx = (idx + 1) % order.length;
      s.season = order[idx];
      if (idx === 0) s.year += 1;
      seasonChanged = true;
    }
    // roll tomorrow's weather BEFORE day handlers so crops see today's water, etc.
    setWeather(rollWeather());
    if (seasonChanged) bus.emit('season:change', { season: s.season, year: s.year });
    bus.emit('day:advance', { day: s.day, dayOfSeason: s.dayOfSeason, season: s.season, year: s.year });
  }

  // Advance the clock by `minutes` game-minutes (may be fractional / large).
  function step(minutes) {
    var s = Game.state;
    if (!minutes || minutes <= 0) return;
    s.tick += minutes;
    var prevPhase = phaseAt(s.minuteOfDay);
    s.minuteOfDay += minutes;
    // handle day rollovers (supports large jumps for fast-forward)
    var guard = 0;
    while (s.minuteOfDay >= 1440) {
      s.minuteOfDay -= 1440;
      advanceDay();
      if (++guard > 3650) { s.minuteOfDay = s.minuteOfDay % 1440; break; } // 10-year safety
    }
    var newPhase = phaseAt(s.minuteOfDay);
    if (newPhase !== prevPhase) {
      if (newPhase === 'night') bus.emit('night:fall', { minuteOfDay: s.minuteOfDay });
      else if (prevPhase === 'night') bus.emit('day:break', { minuteOfDay: s.minuteOfDay });
    }
    bus.emit('tick', { tick: s.tick, dt: minutes });
  }

  function init() { /* clock state comes from newGame/load */ }

  return {
    init: init, step: step, clock: clock,
    isNight: isNight, phaseAt: phaseAt, lightLevel: lightLevel,
    rollWeather: rollWeather, setWeather: setWeather, advanceDay: advanceDay
  };
})();
