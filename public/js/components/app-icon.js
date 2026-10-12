/* 本地线性图标：无需字体或外部请求，离线与原生壳使用同一套图标。 */
const paths = {
  sprout: 'M12 21V11m0 5C5 16 3 12 3 6c6 0 9 3 9 8m0-3c0-6 3-9 9-9 0 6-3 9-9 9',
  ideas: 'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M9 15l1-4L19 2l3 3-9 9-4 1',
  eggs: 'M20 14c0 5-3.6 8-8 8s-8-3-8-8S9 2 12 2s8 7 8 12Z',
  papers: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M8 13h8M8 17h5',
  sites: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18Z',
  expenses: 'M21 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3M3 7h18v13M21 10h-6v6h6M17 13h.01',
  achievements: 'M8 3h8v5a4 4 0 0 1-8 0V3ZM8 5H4v2a4 4 0 0 0 4 4m8-6h4v2a4 4 0 0 1-4 4M12 12v6m-4 3h8m-7-3h6',
  kb: 'M12 5C9 3 6 3 3 4v16c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v16',
  messages: 'M21 11a9 9 0 0 1-9 9 9 9 0 0 1-4-.9L3 21l1.9-5A9 9 0 1 1 21 11ZM8 11h.01M12 11h.01M16 11h.01',
  search: 'M21 21l-5-5m2-6a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  grid: 'M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7Z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  more: 'M4 12h.01M12 12h.01M20 12h.01',
  close: 'm6 6 12 12M6 18 18 6',
  edit: 'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M9 15l1-4L19 2l3 3-9 9-4 1',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  pin: 'M9 3h6l-1 6 4 4v2H6v-2l4-4-1-6Zm3 12v7',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2ZM7 3v6h9V3M7 21v-7h10v7',
};

export const AppIcon = {
  props: { name: { type: String, default: 'sprout' } },
  setup: () => ({ paths }),
  template: `<svg class="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.sprout" /></svg>`,
};
