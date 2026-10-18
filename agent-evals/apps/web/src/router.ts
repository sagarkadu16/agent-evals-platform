import { createRouter, createWebHistory } from 'vue-router'
import ExperimentsPage from './pages/ExperimentsPage.vue'
import ExperimentPage from './pages/ExperimentPage.vue'
import RunPage from './pages/RunPage.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: ExperimentsPage },
    { path: '/experiments/:id', component: ExperimentPage },
    { path: '/runs/:id', component: RunPage },
  ],
  // Links like ?task=…#runs jump to the runs table; other navigations start at the top.
  scrollBehavior: (to, _from, saved) => saved ?? (to.hash ? { el: to.hash, top: 16 } : { top: 0 }),
})
