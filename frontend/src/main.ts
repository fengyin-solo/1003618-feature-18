import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { setActorResolver } from './domain/identity'
import { useSessionStore } from './stores/session'
import './styles/global.css'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(router)
// 领域权限逻辑通过解析器获取当前身份，避免直接耦合 pinia（也便于脚本验证）。
setActorResolver(() => useSessionStore(pinia).identity)
app.mount('#app')
