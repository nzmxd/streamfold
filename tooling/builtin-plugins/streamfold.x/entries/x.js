'use strict';

const CONTENT_METRIC_DEFINITIONS = Object.freeze([{
  id: 'quotes',
  label: '引用',
  valueKind: 'count',
  unit: 'count',
  group: 'engagement',
  sortOrder: 60,
  measurementKind: 'cumulative',
  standardMetricId: null
}]);

const IDENTITY_FAILURE_KEY = '__streamfoldFailure';
const IDENTITY_FAILURES = Object.freeze({
  settingsEmpty: 'X_IDENTITY_SETTINGS_EMPTY',
  currentProfileEmpty: 'X_IDENTITY_CURRENT_PROFILE_EMPTY',
  responseInvalid: 'X_IDENTITY_RESPONSE_INVALID'
});

function fail(message) {
  throw new Error('X 数据无效：' + message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function object(value, label) {
  if (!isObject(value)) fail(label + '必须是对象');
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) fail(label + '必须是数组');
  return value;
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(label + '包含未知字段 ' + key);
  }
}

function string(value, label, maximum) {
  if (typeof value !== 'string') fail(label + '必须是字符串');
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    fail(label + '格式错误');
  }
  return normalized;
}

function id(value, label) {
  const normalized = string(value, label, 128);
  if (!/^\d+$/.test(normalized)) fail(label + '必须是十进制字符串');
  return normalized;
}

function handle(value, label) {
  const normalized = string(value, label, 15);
  if (!/^[A-Za-z0-9_]{1,15}$/.test(normalized)) fail(label + '格式错误');
  return normalized;
}

function optionalString(value, label, maximum) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > maximum || /[\u0000\u007f]/.test(value)) {
    fail(label + '格式错误');
  }
  return value;
}

function count(value, label, allowDecimalString) {
  if (value === undefined || value === null) return null;
  let parsed = value;
  if (allowDecimalString && typeof parsed === 'string' && /^\d+$/.test(parsed)) parsed = Number(parsed);
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) fail(label + '必须是非负安全整数');
  return parsed;
}

function assertNoApiErrors(value, label) {
  if (!own(value, 'errors')) return;
  const errors = array(value.errors, label + '.errors');
  if (errors.length === 0) return;
  fail(label + '返回错误');
}

function readIdentityInput(value) {
  const input = object(value, 'readIdentity 输入');
  exactKeys(input, ['expectedRemoteId'], 'readIdentity 输入');
  if (!own(input, 'expectedRemoteId')) fail('readIdentity 输入缺少 expectedRemoteId');
  return input.expectedRemoteId === null ? null : id(input.expectedRemoteId, 'expectedRemoteId');
}

function collectInput(value) {
  const input = object(value, 'collect 输入');
  exactKeys(input, ['scope', 'boundRemoteId'], 'collect 输入');
  if (!['profile_only', 'recent_20', 'recent_100'].includes(input.scope)) fail('scope 不受支持');
  return { scope: input.scope, boundRemoteId: id(input.boundRemoteId, 'boundRemoteId') };
}

function settingsHandle(value) {
  assertNoApiErrors(value, 'account/settings');
  return handle(value.screen_name, 'account/settings.screen_name');
}

function identityFailure(code) {
  return { [IDENTITY_FAILURE_KEY]: code };
}

function identityPending(context, stage) {
  if (!context || context.capturePolicy !== 'background-cache') {
    return identityFailure(
      stage === 'settings' ? IDENTITY_FAILURES.settingsEmpty : IDENTITY_FAILURES.currentProfileEmpty
    );
  }
  return {
    status: 'capture_pending',
    message: stage === 'settings'
      ? '正在后台监听 X 登录账号设置。'
      : '已识别 X 登录账号，正在后台监听账号资料。'
  };
}

function unwrapUserResult(value, label) {
  let result = object(value, label);
  for (let depth = 0; depth < 2 && !own(result, 'rest_id') && isObject(result.result); depth += 1) {
    result = result.result;
  }
  const typename = typeof result.__typename === 'string' ? result.__typename : '';
  if (typename === 'UserUnavailable' || typename === 'UserTombstone') fail(label + '不可用');
  if (!own(result, 'rest_id')) fail(label + '缺少稳定账号 ID');
  return result;
}

function parseProfileResponse(value, operationName) {
  assertNoApiErrors(value, operationName);
  const data = object(value.data, operationName + '.data');
  const alternateKey = operationName === 'UserByScreenName'
    ? 'user_result_by_screen_name'
    : 'user_result_by_rest_id';
  const userKey = isObject(data.user) ? 'user' : alternateKey;
  const user = object(data[userKey], operationName + '.data.' + userKey);
  const result = unwrapUserResult(user.result, operationName + '.data.' + userKey + '.result');
  const legacy = object(result.legacy, '用户 legacy');
  const core = isObject(result.core) ? result.core : {};
  const avatar = isObject(result.avatar) ? result.avatar : {};
  const profileBio = isObject(result.profile_bio) ? result.profile_bio : {};
  const remoteId = id(result.rest_id, '用户 rest_id');
  const screenName = handle(core.screen_name !== undefined ? core.screen_name : legacy.screen_name, '用户 screen_name');
  const remoteName = string(core.name !== undefined ? core.name : legacy.name, '用户 name', 200);
  const avatarUrl = optionalString(
    avatar.image_url !== undefined ? avatar.image_url : legacy.profile_image_url_https,
    '用户头像',
    2048
  );
  if (avatarUrl && !/^https:\/\/pbs\.twimg\.com\//.test(avatarUrl)) fail('用户头像域名不受支持');
  return {
    remoteId,
    screenName,
    remoteName,
    profile: {
      remoteId,
      remoteName,
      avatarUrl,
      bio: cleanedText(optionalString(
        profileBio.description !== undefined ? profileBio.description : legacy.description,
        '用户简介',
        2000
      )),
      creatorLevel: null,
      followers: count(legacy.followers_count, 'followers_count', false),
      following: count(legacy.friends_count, 'friends_count', false),
      contentCount: count(legacy.statuses_count, 'statuses_count', false),
      viewsTotal: null,
      likesAndFavoritesTotal: null
    }
  };
}

function timelineFromUserResult(result) {
  if (isObject(result.timeline_v2) && isObject(result.timeline_v2.timeline)) return result.timeline_v2.timeline;
  if (isObject(result.timeline) && isObject(result.timeline.timeline)) return result.timeline.timeline;
  fail('UserTweets 缺少 timeline');
}

function unwrapTimelineUserResult(value) {
  let result = object(value, 'UserTweets.data.user.result');
  for (let depth = 0; depth < 2 && !isObject(result.timeline_v2) && !isObject(result.timeline) && isObject(result.result); depth += 1) {
    result = result.result;
  }
  const typename = typeof result.__typename === 'string' ? result.__typename : '';
  if (typename === 'UserUnavailable' || typename === 'UserTombstone') fail('UserTweets 用户不可用');
  return result;
}

function addTweetResult(target, itemContent) {
  if (!isObject(itemContent) || !isObject(itemContent.tweet_results)) return;
  if (!own(itemContent.tweet_results, 'result')) fail('tweet_results 缺少 result');
  target.push(itemContent.tweet_results.result);
}

function tweetResultsFromEntry(entry) {
  const results = [];
  const content = object(entry.content, 'timeline entry.content');
  addTweetResult(results, content.itemContent);
  if (isObject(content.item)) addTweetResult(results, content.item.itemContent);
  if (content.items !== undefined) {
    for (const rawItem of array(content.items, 'timeline module items')) {
      const item = object(rawItem, 'timeline module item');
      const nested = isObject(item.item) ? item.item : item;
      addTweetResult(results, nested.itemContent);
    }
  }
  return results;
}

function unwrapTweetResult(value) {
  if (!isObject(value)) fail('tweet result 必须是对象');
  let result = value;
  const typename = typeof result.__typename === 'string' ? result.__typename : '';
  if (typename === 'TweetTombstone' || typename === 'TweetUnavailable') return null;
  if (typename === 'TweetWithVisibilityResults') result = object(result.tweet, '可见性 tweet');
  else if (!own(result, 'rest_id') && isObject(result.tweet)) result = result.tweet;
  const unwrappedType = typeof result.__typename === 'string' ? result.__typename : '';
  if (unwrappedType === 'TweetTombstone' || unwrappedType === 'TweetUnavailable') return null;
  if (!own(result, 'rest_id')) fail('tweet result 缺少 rest_id');
  return result;
}

function tweetAuthorId(tweet) {
  const core = object(tweet.core, 'tweet.core');
  const userResults = object(core.user_results, 'tweet.core.user_results');
  const user = unwrapUserResult(userResults.result, 'tweet 作者');
  return id(user.rest_id, 'tweet 作者 rest_id');
}

function unicodeSlice(value, maximumCharacters, maximumCodeUnits) {
  let result = '';
  let characters = 0;
  for (const character of value) {
    if (characters >= maximumCharacters || result.length + character.length > maximumCodeUnits) break;
    result += character;
    characters += 1;
  }
  return result;
}

function cleanedText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function tweetText(tweet, legacy) {
  if (isObject(tweet.note_tweet)) {
    const noteResults = tweet.note_tweet.note_tweet_results;
    if (isObject(noteResults) && isObject(noteResults.result) && typeof noteResults.result.text === 'string') {
      return noteResults.result.text;
    }
    if (noteResults !== undefined) fail('note_tweet 结构错误');
  }
  if (typeof legacy.full_text !== 'string') fail('tweet 缺少 full_text');
  return legacy.full_text;
}

function tweetType(tweet, legacy) {
  const extended = isObject(legacy.extended_entities)
    ? legacy.extended_entities
    : (isObject(tweet.extended_entities) ? tweet.extended_entities : null);
  if (!extended || extended.media === undefined) return 'post';
  const media = array(extended.media, 'tweet media');
  let hasImage = false;
  for (const raw of media) {
    const item = object(raw, 'tweet media item');
    if (item.type === 'video' || item.type === 'animated_gif') return 'video';
    if (item.type === 'photo') hasImage = true;
  }
  return hasImage ? 'image' : 'post';
}

function publishedAt(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) fail('tweet created_at 格式错误');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) fail('tweet created_at 格式错误');
  return parsed.toISOString();
}

function normalizeTweet(rawResult, boundRemoteId, capturedAt) {
  const tweet = unwrapTweetResult(rawResult);
  if (!tweet) return null;
  const remoteId = id(tweet.rest_id, 'tweet rest_id');
  if (tweetAuthorId(tweet) !== boundRemoteId) return null;
  const legacy = object(tweet.legacy, 'tweet legacy');
  if (legacy.in_reply_to_status_id_str !== undefined && legacy.in_reply_to_status_id_str !== null) return null;
  if (legacy.in_reply_to_user_id_str !== undefined && legacy.in_reply_to_user_id_str !== null) return null;
  if (legacy.retweeted_status_result !== undefined && legacy.retweeted_status_result !== null) return null;
  const body = cleanedText(tweetText(tweet, legacy));
  const snapshot = {
    views: count(isObject(tweet.views) ? tweet.views.count : null, 'tweet views', true),
    likes: count(legacy.favorite_count, 'tweet favorite_count', false),
    comments: count(legacy.reply_count, 'tweet reply_count', false),
    shares: count(legacy.retweet_count, 'tweet retweet_count', false),
    favorites: count(legacy.bookmark_count, 'tweet bookmark_count', false),
    metrics: { quotes: count(legacy.quote_count, 'tweet quote_count', false) },
    capturedAt
  };
  return {
    remoteId,
    type: tweetType(tweet, legacy),
    title: unicodeSlice(body, 80, 500),
    bodyExcerpt: unicodeSlice(body, 4000, 4000),
    url: 'https://x.com/i/web/status/' + remoteId,
    publishedAt: publishedAt(legacy.created_at),
    snapshots: [snapshot]
  };
}

const KNOWN_INSTRUCTIONS = Object.freeze([
  'TimelineAddEntries',
  'TimelineAddToModule',
  'TimelineClearCache',
  'TimelineMarkEntriesUnreadGreaterThanSortIndex',
  'TimelinePinEntry',
  'TimelineReplaceEntry',
  'TimelineShowAlert',
  'TimelineShowCover',
  'TimelineTerminateTimeline'
]);

function parseTimelineResponse(value, boundRemoteId) {
  assertNoApiErrors(value, 'UserTweets');
  const data = object(value.data, 'UserTweets.data');
  const user = object(data.user, 'UserTweets.data.user');
  const result = unwrapTimelineUserResult(user.result);
  if (result.rest_id !== undefined && id(result.rest_id, 'UserTweets 用户 rest_id') !== boundRemoteId) {
    fail('UserTweets 用户与已绑定账号不一致');
  }
  const timeline = object(timelineFromUserResult(result), 'UserTweets timeline');
  const instructions = array(timeline.instructions, 'UserTweets instructions');
  const tweetResults = [];
  let bottomCursor = null;
  let terminatedBottom = false;
  let ignoredInstruction = false;

  function consumeEntry(rawEntry) {
    const entry = object(rawEntry, 'timeline entry');
    const content = object(entry.content, 'timeline entry.content');
    if (content.cursorType === 'Bottom') {
      const cursor = string(content.value, 'Bottom cursor', 4096);
      if (bottomCursor !== null && bottomCursor !== cursor) fail('单个响应包含冲突的 Bottom cursor');
      bottomCursor = cursor;
    }
    tweetResults.push(...tweetResultsFromEntry(entry));
  }

  for (const rawInstruction of instructions) {
    const instruction = object(rawInstruction, 'timeline instruction');
    const type = typeof instruction.type === 'string' ? instruction.type : instruction.__typename;
    if (typeof type !== 'string' || !KNOWN_INSTRUCTIONS.includes(type)) {
      if (instruction.entries !== undefined || instruction.entry !== undefined || instruction.moduleItems !== undefined) {
        fail('未知 timeline 内容指令');
      }
      ignoredInstruction = true;
      continue;
    }
    if (instruction.entries !== undefined) {
      for (const entry of array(instruction.entries, type + '.entries')) consumeEntry(entry);
    }
    if (instruction.entry !== undefined) consumeEntry(instruction.entry);
    if (instruction.moduleItems !== undefined) {
      for (const moduleItem of array(instruction.moduleItems, type + '.moduleItems')) {
        const item = object(moduleItem, 'timeline module item');
        if (isObject(item.item) && isObject(item.item.content)) consumeEntry({ content: item.item.content });
      }
    }
    if (type === 'TimelineTerminateTimeline' && (instruction.direction === 'Bottom' || instruction.direction === undefined)) {
      terminatedBottom = true;
    }
  }
  return { tweetResults, bottomCursor, terminatedBottom, ignoredInstruction };
}

async function readIdentity(context, rawInput) {
  readIdentityInput(rawInput);
  const settingsResponses = await streamfold.platform.captureJson('x.identity.settings', {}, 1);
  if (!Array.isArray(settingsResponses)) return identityFailure(IDENTITY_FAILURES.responseInvalid);
  if (settingsResponses.length === 0) return identityPending(context, 'settings');
  if (settingsResponses.length !== 1 || !isObject(settingsResponses[0])) {
    return identityFailure(IDENTITY_FAILURES.responseInvalid);
  }
  let authenticatedHandle;
  try {
    authenticatedHandle = settingsHandle(settingsResponses[0]);
  } catch {
    return identityFailure(IDENTITY_FAILURES.responseInvalid);
  }

  const currentResponses = await streamfold.platform.captureJson(
    'x.identity.profile.initial',
    { handle: authenticatedHandle },
    1
  );
  if (!Array.isArray(currentResponses)) return identityFailure(IDENTITY_FAILURES.responseInvalid);
  if (currentResponses.length === 0) return identityPending(context, 'profile');
  if (currentResponses.length !== 1 || !isObject(currentResponses[0])) {
    return identityFailure(IDENTITY_FAILURES.responseInvalid);
  }
  let current;
  try {
    current = parseProfileResponse(currentResponses[0], 'UserByScreenName');
  } catch {
    return identityFailure(IDENTITY_FAILURES.responseInvalid);
  }
  if (current.screenName.toLowerCase() !== authenticatedHandle.toLowerCase()) {
    return identityFailure(IDENTITY_FAILURES.responseInvalid);
  }
  return { remoteId: current.remoteId, remoteName: current.remoteName, profile: current.profile };
}

async function collect(_context, rawInput) {
  const input = collectInput(rawInput);
  const capturedAt = new Date().toISOString();
  if (input.scope === 'profile_only') {
    return {
      capturedAt,
      profile: null,
      contentMetricDefinitions: CONTENT_METRIC_DEFINITIONS,
      contents: [],
      coverage: { requestedContentCount: 0, actualContentCount: 0, paginationEnded: true },
      warnings: []
    };
  }

  const target = input.scope === 'recent_20' ? 20 : 100;
  const responseLimit = input.scope === 'recent_20' ? 5 : 20;
  const responses = array(await streamfold.platform.captureJson(
    'x.contents.tweets.bound',
    { remoteId: input.boundRemoteId },
    responseLimit
  ), 'UserTweets 响应');
  if (responses.length === 0 || responses.length > responseLimit) fail('UserTweets 响应数量无效');

  const contentsById = new Map();
  const seenBottomCursors = new Set();
  let repeatedBottomCursorCount = 0;
  let ignoredInstruction = false;
  let lastPage = null;
  for (const rawResponse of responses) {
    const page = parseTimelineResponse(object(rawResponse, 'UserTweets 响应体'), input.boundRemoteId);
    ignoredInstruction = ignoredInstruction || page.ignoredInstruction;
    if (page.bottomCursor !== null) {
      if (seenBottomCursors.has(page.bottomCursor)) repeatedBottomCursorCount += 1;
      else seenBottomCursors.add(page.bottomCursor);
    }
    const pageContentsById = new Map();
    for (const rawTweet of page.tweetResults) {
      const content = normalizeTweet(rawTweet, input.boundRemoteId, capturedAt);
      if (!content) continue;
      const previous = pageContentsById.get(content.remoteId);
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(content)) fail('重复 tweet 数据冲突');
      if (previous === undefined) pageContentsById.set(content.remoteId, content);
    }
    for (const [remoteId, content] of pageContentsById) contentsById.set(remoteId, content);
    lastPage = page;
  }

  const contents = Array.from(contentsById.values());
  const warnings = [];
  if (ignoredInstruction) warnings.push('已忽略 X 时间线中的非内容指令。');
  if (repeatedBottomCursorCount > 0) {
    warnings.push(
      'X 时间线捕获到 ' + repeatedBottomCursorCount +
      ' 个重复分页游标；已合并重复响应并继续保存可验证内容。'
    );
  }
  if (contents.length < target && lastPage && lastPage.bottomCursor !== null && !lastPage.terminatedBottom) {
    warnings.push(
      'X 时间线在完整捕获窗口内读取 ' + responses.length + '/' + responseLimit +
      ' 个响应后仍有更多内容；本次已保存 ' + contents.length +
      ' 条已验证本人内容，少于请求的 ' + target + ' 条。'
    );
  }
  return {
    capturedAt,
    profile: null,
    contentMetricDefinitions: CONTENT_METRIC_DEFINITIONS,
    contents: contents.slice(0, target),
    coverage: {
      requestedContentCount: target,
      actualContentCount: Math.min(contents.length, target),
      paginationEnded: Boolean(lastPage && (lastPage.bottomCursor === null || lastPage.terminatedBottom))
    },
    warnings
  };
}

module.exports = { readIdentity, collect };
