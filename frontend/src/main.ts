import { createApp } from 'vue'
import { createPinia } from 'pinia'

import { ensureVerificationSeed } from '@/api/burn-flow'
import App from './App.vue'
import router from './router'
import './styles/global.css'

// 历史已执行用火单的检查站/巡护核查在首屏前播种，保证两个入口初始就同步。
ensureVerificationSeed()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
