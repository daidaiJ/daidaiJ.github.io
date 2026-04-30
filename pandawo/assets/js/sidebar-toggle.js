(function() {
    'use strict';

    const STORAGE_KEY = 'pandawo-sidebar-state';

    const SidebarToggle = {
        init: function() {
            // 获取侧边栏元素
            var leftSidebar = document.getElementById('left-sidebar');
            var rightSidebar = document.getElementById('right-sidebar');
            var toggleButtons = document.querySelectorAll('.sidebar-toggle-btn');

            if (!leftSidebar && !rightSidebar) return;

            // 从 localStorage 加载状态
            var savedState = this.loadState();
            if (leftSidebar && savedState.left) {
                this.toggleSidebar(leftSidebar, true);
            }
            if (rightSidebar && savedState.right) {
                this.toggleSidebar(rightSidebar, true);
            }

            // 绑定按钮点击事件
            toggleButtons.forEach(function(btn) {
                btn.addEventListener('click', function(e) {
                    e.preventDefault();
                    var sidebarType = this.getAttribute('data-sidebar');
                    var sidebar = sidebarType === 'left' ? leftSidebar : rightSidebar;
                    if (sidebar) {
                        SidebarToggle.toggleSidebar(sidebar);
                        SidebarToggle.saveState({
                            left: leftSidebar ? leftSidebar.classList.contains('collapsed') : false,
                            right: rightSidebar ? rightSidebar.classList.contains('collapsed') : false
                        });
                    }
                });
            });
        },

        toggleSidebar: function(sidebar, forceCollapse) {
            if (forceCollapse === undefined) {
                sidebar.classList.toggle('collapsed');
            } else {
                if (forceCollapse) {
                    sidebar.classList.add('collapsed');
                } else {
                    sidebar.classList.remove('collapsed');
                }
            }
        },

        loadState: function() {
            try {
                var state = localStorage.getItem(STORAGE_KEY);
                return state ? JSON.parse(state) : { left: false, right: false };
            } catch (e) {
                return { left: false, right: false };
            }
        },

        saveState: function(state) {
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            } catch (e) {
                // localStorage 不可用时静默失败
            }
        }
    };

    // 页面加载完成后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', SidebarToggle.init);
    } else {
        SidebarToggle.init();
    }
})();