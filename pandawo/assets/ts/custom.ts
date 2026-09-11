// 侧边栏折叠/展开（状态持久化到 localStorage）
const COLLAPSE_KEYS = {
    left: 'stack-left-sidebar-collapsed',
    right: 'stack-right-sidebar-collapsed',
} as const;

function setCollapsed(side: 'left' | 'right', collapsed: boolean) {
    const bodyClass = side === 'left' ? 'left-collapsed' : 'right-collapsed';
    document.body.classList.toggle(bodyClass, collapsed);
    localStorage.setItem(COLLAPSE_KEYS[side], collapsed ? '1' : '0');

    const btn = document.getElementById(side === 'left' ? 'collapse-left' : 'collapse-right');
    if (btn) {
        btn.setAttribute('aria-expanded', String(!collapsed));
        btn.setAttribute('title', collapsed ? '展开侧边栏' : '折叠侧边栏');
    }
}

function initSidebarCollapse(btnId: string, side: 'left' | 'right') {
    const btn = document.getElementById(btnId);
    if (!btn) return;

    btn.addEventListener('click', () => {
        setCollapsed(side, !document.body.classList.contains(side === 'left' ? 'left-collapsed' : 'right-collapsed'));
    });
    setCollapsed(side, localStorage.getItem(COLLAPSE_KEYS[side]) === '1');
}

initSidebarCollapse('collapse-left', 'left');
initSidebarCollapse('collapse-right', 'right');

// 折叠窄条里的按钮组
document.querySelectorAll('[data-collapse-action]').forEach(btn => {
    btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-collapse-action');
        if (action === 'expand' || action === 'menu') {
            // md+ 视口菜单常显，展开侧边栏后自然可见
            setCollapsed('left', false);
        } else if (action === 'dark') {
            document.getElementById('dark-mode-toggle')?.click();
        }
    });
});
// 纵向滚轮穿透：新版 Chromium/Edge 会把纵向滚轮优先消费给横向滚动容器
// （相关文章横条、超宽代码块），光标悬停其上时页面滚动被"冻结"。
// 这里把纵向 delta 还给页面；横向滚动（shift+滚轮 / 触控板横扫）保持原生行为。
const wheelPassthrough = (el: HTMLElement) => {
    el.addEventListener('wheel', (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            e.preventDefault();
            window.scrollBy({ top: e.deltaY, behavior: 'instant' });
        }
    }, { passive: false });
};

document.querySelectorAll<HTMLElement>('.related-content').forEach(wheelPassthrough);
document.querySelectorAll<HTMLElement>('.highlight .lntable td:last-child').forEach(wheelPassthrough);
document.querySelectorAll<HTMLElement>('.highlight > pre').forEach(wheelPassthrough);
