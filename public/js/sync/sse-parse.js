/* 拾穗集 —— SSE 文本流增量解析（纯函数，无任何依赖，node 可直接单测）
 *
 * 服务端 /api/events 的帧格式（标准 Server-Sent Events）：
 *   ": hb 1690000000000"            注释行 = 心跳，只保活，不触发客户端逻辑
 *   "event: changed" + "data: {...}" + 空行   一个完整事件
 * 兼容 \r\n 换行与「事件被网络分块从中间切开」的情况：解析器自己攒 buffer。
 */

export function createSseParser() {
  let buffer = '';
  let eventName = '';
  let dataLines = [];

  function dispatch(events) {
    // 只有注释行、没有 data 的事件（如纯心跳）不算事件
    if (!eventName && !dataLines.length) return;
    events.push({ event: eventName || 'message', data: dataLines.join('\n') });
    eventName = '';
    dataLines = [];
  }

  return {
    /** 喂入一段新到达的文本，返回其间凑齐的事件 [{ event, data }] */
    push(text) {
      buffer += String(text || '');
      // \r\n 统一成 \n；分块边界上的孤立 \r 留在 buffer 里，下一段拼上后再归一
      buffer = buffer.replace(/\r\n/g, '\n');
      const events = [];
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line === '') { dispatch(events); continue; } // 空行 = 事件结束
        if (line.startsWith(':')) continue;              // 注释/心跳
        if (line.startsWith('event:')) { eventName = line.slice(6).trim(); continue; }
        if (line.startsWith('data:')) { dataLines.push(line.slice(5).replace(/^ /, '')); continue; }
        // retry:/id: 等其它字段与本客户端无关，忽略
      }
      return events;
    },
  };
}
