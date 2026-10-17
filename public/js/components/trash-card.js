/* ---------------- 组件：回收站卡片（M20 任务 D / M21-A）----------------
 * 一条被删掉的记录：来源板块徽标 + 标题 + 删除时间 + 还剩几天。
 * M21-A：卡片默认展开，把被删记录的完整内容（详情行）原样铺开——用户要先能
 * 确认「删掉的是什么」，才谈得上恢复还是彻底删除；不再只给 60 字摘要。
 * 只有两个动作：恢复、彻底删除（不可反悔，调用方必须先二次确认）。
 */

import { computed } from '../vue-globals.js';
import { formatDate } from '../util/date.js';
import { TRASH_SOURCE_META, trashDaysLeft, trashDetailRows } from '../util/trash.js';
import { useImageUrls } from '../img-urls.js';

const TrashCard = {
  name: 'TrashCard',
  props: { entry: { type: Object, required: true }, now: { type: Number, default: () => Date.now() } },
  emits: ['restore', 'purge'],
  setup(props, { emit }) {
    const sourceMeta = computed(() => TRASH_SOURCE_META[props.entry.source] || { label: props.entry.source || '未知', emoji: '🗑' });
    const daysLeft = computed(() => trashDaysLeft(props.entry, props.now));

    // 卡片头只放真正的标题字段；没有标题就不占一行（正文会在详情行里完整出现），
    // 避免把整段正文当标题在头部重复一遍。
    const payload = computed(() => (props.entry && props.entry.payload) || {});
    const headTitle = computed(() => {
      const p = payload.value;
      const t = p.title || p.name || '';
      return String(t).trim();
    });

    // 详情行 = 纯函数给出的完整字段；卡片头已展示的标题不再重复
    const rows = computed(() => trashDetailRows(props.entry)
      .filter((row) => !(row.label === '标题' && row.value === headTitle.value)));

    // 随记贴图：回收站里图片文件尚未删除（彻底删除/到期才 prune），/api/images/:id 仍可读
    const images = computed(() => {
      if (props.entry.source !== 'ideas') return [];
      const list = payload.value.images;
      return Array.isArray(list) ? list : [];
    });
    const { urls: imgUrls } = useImageUrls(images);

    return {
      sourceMeta, daysLeft, headTitle, rows, images, imgUrls, formatDate,
      emitRestore: () => emit('restore'),
      emitPurge: () => emit('purge'),
    };
  },
  template: `
  <article class="card trash-card">
    <div class="card-head">
      <span class="platform">{{ sourceMeta.emoji }} {{ sourceMeta.label }}</span>
      <h3 class="title" v-if="headTitle">{{ headTitle }}</h3>
    </div>
    <div class="meta trash-meta">
      <span class="chip">🗑 {{ formatDate(entry.deleted_at) }} 删除</span>
      <span class="chip trash-days" :class="{ warn: daysLeft <= 7 }">
        {{ daysLeft > 0 ? '剩 ' + daysLeft + ' 天' : '今天到期' }}
      </span>
    </div>

    <!-- 默认展开的完整内容：pre-wrap 不截断，长 URL / 长正文在双列里也不撑破卡片 -->
    <div class="trash-detail" v-if="rows.length || images.length">
      <div class="trash-row" v-for="(row, i) in rows" :key="row.label + ':' + i"
           :class="{ 'is-multiline': row.multiline }">
        <span class="trash-row-label">{{ row.label }}</span>
        <span class="trash-row-value">{{ row.value }}</span>
      </div>
      <div class="trash-imgs" v-if="images.length">
        <template v-for="im in images" :key="im.id">
          <img v-if="imgUrls[im.id]" :src="imgUrls[im.id]" :alt="im.name" :title="im.name" loading="lazy">
          <span v-else class="trash-img-missing" :title="(im.name || '图片') + '（暂时加载不出来）'">🖼</span>
        </template>
      </div>
    </div>

    <div class="card-actions">
      <button class="btn small" @click="emitRestore">↩︎ 恢复</button>
      <span class="spacer"></span>
      <button class="btn small danger" @click="emitPurge" title="彻底删除，无法恢复" aria-label="彻底删除">
        <app-icon name="trash"></app-icon>
      </button>
    </div>
  </article>
  `,
};

export { TrashCard };
