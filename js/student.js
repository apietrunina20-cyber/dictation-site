(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  if (!window.FIREBASE_CONFIG_IS_SET || !window.FIREBASE_CONFIG_IS_SET()) {
    $('view-setup').style.display = 'block';
    return;
  }

  firebase.initializeApp(window.FIREBASE_CONFIG);
  var db = firebase.firestore();

  var sessionCode = null;
  var participantId = null;
  var session = null;
  var answers = [];
  var roundPointsArr = [];
  var correctFlags = [];
  var participantTotalPoints = 0;
  var participantCorrectCount = 0;
  var lastRoundResult = null;
  var roundStartMs = Date.now();
  var lastHandledIndex = -1;
  var submittedThisRound = false;
  var finishedHandled = false;
  var tabSwitchCount = 0;

  // Если ученик сворачивает вкладку/переключается на другую (например, чтобы
  // подсмотреть перевод на стороннем сайте) — считаем это и сразу сообщаем
  // учителю в реальном времени (виден счётчик у него в кабинете).
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && sessionCode && participantId) {
      tabSwitchCount++;
      db.collection('sessions').doc(sessionCode).collection('participants').doc(participantId).set({
        tabSwitches: tabSwitchCount
      }, { merge: true });
    }
  });

  showView('view-join');

  var params = new URLSearchParams(window.location.search);
  if (params.get('code')) $('join-code').value = params.get('code').toUpperCase();

  $('join-code').addEventListener('input', function () {
    this.value = this.value.toUpperCase();
  });

  $('join-btn').addEventListener('click', function () {
    var code = $('join-code').value.trim().toUpperCase();
    var name = $('join-name').value.trim();
    $('join-error').style.display = 'none';
    if (!code || !name) {
      showJoinError('Заполни код и имя.');
      return;
    }
    $('join-btn').disabled = true;
    db.collection('sessions').doc(code).get().then(function (doc) {
      if (!doc.exists) {
        showJoinError('Игра с таким кодом не найдена. Проверь код у учителя.');
        $('join-btn').disabled = false;
        return;
      }
      sessionCode = code;
      $('footer-code').textContent = 'Код игры: ' + code;
      participantId = Dictation.getParticipantId(code);
      var pRef = db.collection('sessions').doc(code).collection('participants').doc(participantId);
      pRef.get().then(function (pDoc) {
        var setup = pDoc.exists ? Promise.resolve() : pRef.set({
          name: name,
          joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
          lastAnsweredIndex: -1,
          totalPoints: 0
        });
        Promise.resolve(setup).then(function () {
          if (pDoc.exists) {
            var d = pDoc.data();
            participantTotalPoints = d.totalPoints || 0;
            roundPointsArr = d.roundPoints || [];
            correctFlags = d.correctFlags || [];
            answers = d.answers || [];
            tabSwitchCount = d.tabSwitches || 0;
          }
          if (pDoc.exists && pDoc.data().percent !== undefined && pDoc.data().percent !== null) {
            // Уже проходил(а) эту игру — сразу показываем результат.
            db.collection('sessions').doc(code).get().then(function (sDoc) {
              showStoredResult(sDoc.data(), pDoc.data());
            });
          } else {
            listenToSession(code);
          }
        });
      });
    }).catch(function (err) {
      showJoinError('Ошибка: ' + err.message);
      $('join-btn').disabled = false;
    });
  });

  function showJoinError(msg) {
    $('join-error').textContent = msg;
    $('join-error').style.display = 'block';
  }

  function listenToSession(code) {
    db.collection('sessions').doc(code).onSnapshot(function (doc) {
      if (!doc.exists) return;
      session = doc.data();
      handleSessionUpdate();
    });
  }

  function handleSessionUpdate() {
    if (session.status === 'waiting') {
      showView('view-waiting');
      $('waiting-title').textContent = session.title;
    } else if (session.status === 'playing') {
      var idx = session.currentIndex;
      var total = session.pairs.length;

      if (idx !== lastHandledIndex) {
        lastHandledIndex = idx;
        submittedThisRound = false;
        roundStartMs = (session.roundStartedAt && session.roundStartedAt.toMillis) ? session.roundStartedAt.toMillis() : Date.now();

        showView('view-dictation');
        $('sentence-progress').textContent = 'Слово ' + (idx + 1) + ' из ' + total;
        $('prompt-word').textContent = (session.pairs[idx] || {}).ru || '';
        $('answer-panel').style.display = 'block';
        $('waiting-panel').style.display = 'none';
        $('current-answer').value = '';
        $('current-answer').disabled = false;
        $('submit-answer-btn').disabled = false;
        $('current-answer').focus();
      }
    } else if (session.status === 'reveal') {
      if (!submittedThisRound) submitCurrentAnswer();
      showRoundResult();
    } else if (session.status === 'finished') {
      if (!finishedHandled) {
        finishedHandled = true;
        if (!submittedThisRound) submitCurrentAnswer();
        Dictation.cancelSpeech();
        finalizeResults();
      }
    }
  }

  function submitCurrentAnswer() {
    if (submittedThisRound) return;
    submittedThisRound = true;
    var idx = lastHandledIndex;
    if (idx < 0 || !session) return;
    var text = $('current-answer') ? $('current-answer').value : '';
    answers[idx] = text;
    var elapsed = Date.now() - roundStartMs;
    var result = Dictation.scoreWordRound(session.pairs[idx].en, text, elapsed);
    lastRoundResult = result;
    roundPointsArr[idx] = result.points;
    correctFlags[idx] = result.correct;
    participantTotalPoints += result.points;
    if (result.correct) participantCorrectCount++;

    $('current-answer').disabled = true;
    $('submit-answer-btn').disabled = true;
    $('answer-panel').style.display = 'none';
    $('waiting-panel').style.display = 'block';

    db.collection('sessions').doc(sessionCode).collection('participants').doc(participantId).set({
      answers: answers,
      roundPoints: roundPointsArr,
      correctFlags: correctFlags,
      totalPoints: participantTotalPoints,
      lastAnsweredIndex: idx,
      lastAnsweredAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }

  $('submit-answer-btn').addEventListener('click', function () { submitCurrentAnswer(); });
  $('current-answer').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); submitCurrentAnswer(); }
  });

  function showStoredResult(sessionData, participantData) {
    participantTotalPoints = participantData.totalPoints || 0;
    var flags = participantData.correctFlags || [];
    var correctCount = flags.filter(Boolean).length;
    renderResults(sessionData.pairs, participantData.answers || [], flags, correctCount);
  }

  /* ---------- Результат раунда ---------- */

  function showRoundResult() {
    showView('view-round-result');
    var idx = lastHandledIndex;
    var pair = session.pairs[idx] || {};
    var result = lastRoundResult || Dictation.scoreWordRound(pair.en, answers[idx] || '', 0);
    $('round-result-num').textContent = (idx + 1) + ' из ' + session.pairs.length;
    $('round-result-icon').textContent = result.correct ? '✅' : '❌';
    $('round-points-badge').textContent = '+' + result.points;
    $('round-points-note').textContent = result.correct ? 'Верно!' : 'Неверно';
    $('round-correct-answer').textContent = pair.ru + '  →  ' + result.correctAnswer;
    fetchRankAndShow($('round-rank-note'), 'Место в рейтинге сейчас: ');
  }

  $('round-listen-btn').addEventListener('click', function () {
    var idx = lastHandledIndex;
    var pair = session ? session.pairs[idx] : null;
    if (!pair) return;
    var first = Dictation.alternativesFor(pair.en)[0] || pair.en;
    Dictation.speak(first, { rate: 0.9 });
  });

  function fetchRankAndShow(el, prefix) {
    if (!sessionCode) return;
    db.collection('sessions').doc(sessionCode).collection('participants').get().then(function (snap) {
      var arr = [];
      snap.forEach(function (d) { arr.push({ id: d.id, points: (d.data().totalPoints || 0) }); });
      arr.sort(function (a, b) { return b.points - a.points; });
      var rank = arr.findIndex(function (x) { return x.id === participantId; }) + 1;
      el.textContent = rank > 0 ? (prefix + rank + ' из ' + arr.length) : '';
    }).catch(function () { el.textContent = ''; });
  }

  /* ---------- Итоговые результаты ---------- */

  function finalizeResults() {
    var total = session.pairs.length;
    var percent = total > 0 ? Math.round((participantCorrectCount / total) * 100) : 0;
    db.collection('sessions').doc(sessionCode).collection('participants').doc(participantId).set({
      answers: answers,
      correctFlags: correctFlags,
      correctCount: participantCorrectCount,
      totalWords: total,
      percent: percent,
      totalPoints: participantTotalPoints,
      tabSwitches: tabSwitchCount,
      finishedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    renderResults(session.pairs, answers, correctFlags, participantCorrectCount);
  }

  function renderResults(pairs, answersList, flags, correctCount) {
    showView('view-results');
    var total = pairs.length;
    var percent = total > 0 ? Math.round((correctCount / total) * 100) : 0;
    $('score-badge').textContent = correctCount + '/' + total;
    $('score-summary').textContent = percent + '% слов угадано верно.';
    fetchRankAndShow($('final-points-note'), 'Очки: ' + participantTotalPoints + ' · место в рейтинге: ');
    var list = $('results-list');
    list.innerHTML = '';
    pairs.forEach(function (pair, idx) {
      var ok = !!flags[idx];
      var div = document.createElement('div');
      div.className = 'diff-sentence';
      div.innerHTML =
        '<span class="num">' + (idx + 1) + '.</span> ' +
        (ok ? '✅' : '❌') + ' <strong>' + escapeHtml(pair.ru) + '</strong> → ' +
        '<span class="' + (ok ? 'tok-correct' : 'tok-extra') + '">' + escapeHtml(answersList[idx] || '(нет ответа)') + '</span>' +
        (ok ? '' : ' <span class="muted">(правильно: ' + escapeHtml(Dictation.alternativesFor(pair.en).join(' / ')) + ')</span>');
      list.appendChild(div);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function showView(id) {
    ['view-join', 'view-waiting', 'view-dictation', 'view-round-result', 'view-results'].forEach(function (v) {
      $(v).style.display = v === id ? 'block' : 'none';
    });
  }
})();
