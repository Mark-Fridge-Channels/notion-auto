/**
 * 脚本退出码约定：供 Dashboard 区分异常退出与主动请求的恢复重启。
 */

/** 浏览器卡住等场景下请求恢复重启，Dashboard 重启但不计入连续重启告警 */
export const EXIT_RECOVERY_RESTART = 2;
