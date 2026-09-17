/* Общие утилиты сайта словарных викторин: разбор списка слов, проверка
   ответа ученика (рус → англ) и подсчёт очков в стиле Kahoot.
   Подключается на всех страницах через <script src="js/common.js"></script>
   и доступен как глобальный объект window.Dictation */
(function (global) {
  'use strict';

  var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без O/0, I/1 — чтобы не путать на слух/глаз

  function generateSessionCode(length) {
    length = length || 6;
    var out = '';
    for (var i = 0; i < length; i++) {
      out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return out;
  }

  // Разбирает список слов вида "русское слово - английский перевод" (по одному
  // на строку; в качестве разделителя подходят "-", "—", ":", "=" с пробелами
  // по бокам, либо табуляция). Английскую часть можно указать несколькими
  // вариантами через "/", например: "быстрый - quick / fast".
  function parseWordPairs(text) {
    if (!text) return [];
    var delimRe = /\s[-—:=]\s|\t/;
    return text.replace(/\r\n/g, '\n').split('\n').map(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return null;
      var m = trimmed.match(delimRe);
      if (!m) return null;
      var ru = trimmed.slice(0, m.index).trim();
      var en = trimmed.slice(m.index + m[0].length).trim();
      if (!ru || !en) return null;
      return { ru: ru, en: en };
    }).filter(Boolean);
  }

  function normalizeAnswer(s) {
    return String(s || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-zа-яё0-9\s'-]/gi, '')
      .replace(/\s+/g, ' ');
  }

  // Английское поле может содержать несколько допустимых ответов через "/".
  function alternativesFor(enField) {
    return String(enField || '').split('/').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  // Очки за одно слово (как в Kahoot): за верный ответ — от 500 до 1000 очков
  // в зависимости от скорости (максимум за первые секунды, плавно убывает
  // к 20-й секунде), за неверный — 0.
  function scoreWordRound(enField, studentAnswer, elapsedMs) {
    var alts = alternativesFor(enField);
    var normAlts = alts.map(normalizeAnswer);
    var normAnswer = normalizeAnswer(studentAnswer);
    var correct = normAnswer.length > 0 && normAlts.indexOf(normAnswer) !== -1;
    var points = 0;
    if (correct) {
      var capped = Math.min(Math.max(elapsedMs || 0, 0), 20000);
      var speedFactor = 1 - (capped / 20000) * 0.5;
      points = Math.round(1000 * speedFactor);
    }
    return { correct: correct, points: points, correctAnswer: alts.join(' / ') };
  }

  /* ---------- Синтез речи (Web Speech API) — для озвучки правильного ответа ---------- */

  function getEnglishVoices() {
    var voices = global.speechSynthesis ? global.speechSynthesis.getVoices() : [];
    var en = voices.filter(function (v) { return /^en/i.test(v.lang); });
    return en.length ? en : voices;
  }

  function speak(text, opts) {
    opts = opts || {};
    if (!global.speechSynthesis) {
      if (opts.onerror) opts.onerror(new Error('speechSynthesis не поддерживается в этом браузере'));
      return;
    }
    global.speechSynthesis.cancel();
    var utter = new SpeechSynthesisUtterance(text);
    utter.lang = opts.lang || 'en-US';
    utter.rate = opts.rate || 0.95;
    if (opts.onend) utter.onend = opts.onend;
    if (opts.onerror) utter.onerror = opts.onerror;
    global.speechSynthesis.speak(utter);
  }

  function cancelSpeech() {
    if (global.speechSynthesis) global.speechSynthesis.cancel();
  }

  /* ---------- localStorage: постоянный ID участника на устройстве ---------- */

  function getParticipantId(sessionCode) {
    var key = 'dictation_pid_' + sessionCode;
    var id = null;
    try { id = localStorage.getItem(key); } catch (e) {}
    if (!id) {
      id = 'p_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      try { localStorage.setItem(key, id); } catch (e) {}
    }
    return id;
  }

  global.Dictation = {
    generateSessionCode: generateSessionCode,
    parseWordPairs: parseWordPairs,
    normalizeAnswer: normalizeAnswer,
    alternativesFor: alternativesFor,
    scoreWordRound: scoreWordRound,
    getEnglishVoices: getEnglishVoices,
    speak: speak,
    cancelSpeech: cancelSpeech,
    getParticipantId: getParticipantId
  };
})(window);
