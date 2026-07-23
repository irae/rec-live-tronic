import { createRouter, createWebHistory } from "vue-router";
import ArchiveView from "./views/ArchiveView.vue";
import ScheduleView from "./views/ScheduleView.vue";
import RecordingDetail from "./views/RecordingDetail.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      name: "archive",
      component: ArchiveView,
      meta: { title: "Tronic · Archive" },
    },
    {
      path: "/schedule",
      name: "schedule",
      component: ScheduleView,
      meta: { title: "Tronic · Schedule" },
    },
    {
      path: "/watch/:id",
      name: "detail",
      component: RecordingDetail,
      meta: { title: "Tronic" },
    },
  ],
});

router.afterEach((to) => {
  const title = typeof to.meta.title === "string" ? to.meta.title : "Tronic";
  document.title = title;
});

export default router;
