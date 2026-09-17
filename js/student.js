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
  var participantTotalPoints = 0;
  var lastRoundResult = null;
  var roundStartMs = Date.now();
  var lastHandledIndex = -1;
  var lastHandledNonce = null;
  var submittedThisRound = false;
  var finishedHandled = false;
  var rate = parseFloat(localStorage.getItem('dictation_rate') || '0.9');
  var chosenVoiceURI = localStorage.getItem('dictation_voice') || '';

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
        showJoinError('Диктант с таким кодом не найден. Проверь код у учителя.');
        $('join-btn').disabled = false;
        return;
      }
      sessionCode = code;
      $('footer-code').textContent = 'Код диктанта: ' + code;
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
            answers = d.answers || [];
          }
          if (pDoc.exists && pDoc.data().score !== undefined && pDoc.data().score !== null) {
            // Уже проходил(а) этот диктант — сразу показываем результат.
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
      var total = session.sentences.length;

      if (idx !== lastHandledIndex) {
        lastHandledIndex = idx;
        lastHandledNonce = session.repeatNonce;
        submittedThisRound = false;
        roundStartMs = (session.roundStartedAt && session.roundStartedAt.toMillis) ? session.roundStartedAt.toMillis() : Date.now();

        showView('view-dictation');
        $('dictation-title').textContent = session.title;
        $('sentence-progress').textContent = 'Предложение ' + (idx + 1) + ' из ' + total;
        $('answer-panel').style.display = 'block';
        $('waiting-panel').style.display = 'none';
        $('current-answer').value = '';
        $('current-answer').disabled = false;
        $('submit-answer-btn').disabled = false;
        $('current-answer').focus();
        speakCurrent();
      } else if (session.repeatNonce !== lastHandledNonce) {
        lastHandledNonce = session.repeatNonce;
        if (!submittedThisRound) speakCurrent();
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
    var result = Dictation.scoreRound(session.sentences[idx], text, elapsed);
    lastRoundResult = result;
    roundPointsArr[idx] = result.points;
    participantTotalPoints += result.points;

    $('current-answer').disabled = true;
    $('submit-answer-btn').disabled = true;
    $('answer-panel').style.display = 'none';
    $('waiting-panel').style.display = 'block';

    db.collection('sessions').doc(sessionCode).collection('participants').doc(participantId).set({
      answers: answers,
      roundPoints: roundPointsArr,
      totalPoints: participantTotalPoints,
      lastAnsweredIndex: idx,
      lastAnsweredAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }

  $('submit-answer-btn').addEventListener('click', function () { submitCurrentAnswer(); });

  function showStoredResult(sessionData, participantData) {
    var answersStored = participantData.answers || [];
    participantTotalPoints = participantData.totalPoints || 0;
    var score = Dictation.scoreDictation(sessionData.sentences, answersStored);
    renderResults(sessionData.sentences, score);
  }

  function speakCurrent() {
    if (!session) return;
    var text = session.sentences[lastHandledIndex];
    $('speaker-icon').style.opacity = '1';
    Dictation.speak(text, {
      rate: rate,
      voiceURI: chosenVoiceURI || undefined,
      onend: function () { $('speaker-icon').style.opacity = '0.4'; }
    });
  }

  $('replay-btn').addEventListener('click', function () { speakCurrent(); });

  /* ---------- Настройки голоса ---------- */

  $('settings-toggle').addEventListener('click', function () {
    var panel = $('settings-panel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });

  function populateVoices() {
    var voices = Dictation.getEnglishVoices();
    var sel = $('voice-select');
    sel.innerHTML = '';
    voices.forEach(function (v) {
      var opt = document.createElement('option');
      opt.value = v.voiceURI;
      opt.textContent = v.name + ' (' + v.lang + ')';
      if (v.voiceURI === chosenVoiceURI) opt.selected = true;
      sel.appendChild(opt);
    });
  }
  if (window.speechSynthesis) {
    populateVoices();
    window.speechSynthesis.onvoiceschanged = populateVoices;
  }
  $('voice-select').addEventListener('change', function () {
    chosenVoiceURI = this.value;
    localStorage.setItem('dictation_voice', chosenVoiceURI);
  });
  $('rate-range').value = rate;
  $('rate-value').textContent = rate;
  $('rate-range').addEventListener('input', function () {
    rate = parseFloat(this.value);
    $('rate-value').textContent = rate.toFixed(1);
    localStorage.setItem('dictation_rate', rate);
  });

  /* ---------- Результат раунда ---------- */

  function showRoundResult() {
    showView('view-round-result');
    var idx = lastHandledIndex;
    var result = lastRoundResult || Dictation.scoreRound(session.sentences[idx] || '', answers[idx] || '', 0);
    $('round-result-num').textContent = (idx + 1) + ' из ' + session.sentences.length;
    $('round-points-badge').textContent = '+' + result.points;
    $('round-points-note').textContent = result.percent + '% слов совпало с оригиналом';
    var html = '';
    result.tokens.forEach(function (tok) {
      var cls = tok.type === 'correct' ? 'tok-correct' : tok.type === 'missing' ? 'tok-missing' : 'tok-extra';
      html += '<span class="' + cls + '">' + escapeHtml(tok.text) + '</span> ';
    });
    $('round-result-diff').innerHTML = html;
    fetchRankAndShow($('round-rank-note'), 'Место в рейтинге сейчас: ');
  }

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
    var score = Dictation.scoreDictation(session.sentences, answers);
    db.collection('sessions').doc(sessionCode).collection('participants').doc(participantId).set({
      answers: answers,
      score: score.percent,
      totalWords: score.totalWords,
      totalCorrect: score.totalCorrect,
      totalPoints: participantTotalPoints,
      finishedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    renderResults(session.sentences, score);
  }

  function renderResults(sentences, score) {
    showView('view-results');
    $('score-badge').textContent = score.percent + '%';
    $('score-summary').textContent = score.totalCorrect + ' из ' + score.totalWords + ' слов совпадают с оригиналом.';
    fetchRankAndShow($('final-points-note'), 'Очки: ' + participantTotalPoints + ' · место в рейтинге: ');
    var list = $('results-list');
    list.innerHTML = '';
    score.perSentence.forEach(function (d, idx) {
      var div = document.createElement('div');
      div.className = 'diff-sentence';
      var html = '<span class="num">' + (idx + 1) + '.</span>';
      d.tokens.forEach(function (tok) {
        var cls = tok.type === 'correct' ? 'tok-correct' : tok.type === 'missing' ? 'tok-missing' : 'tok-extra';
        html += '<span class="' + cls + '">' + escapeHtml(tok.text) + '</span> ';
      });
      div.innerHTML = html;
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
