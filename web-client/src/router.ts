import { createRouter, createWebHistory } from "vue-router";
import ArchiveView from "./views/ArchiveView.vue";
import ScheduleView from "./views/ScheduleView.vue";
import RecordingDetail from "./views/RecordingDetail.vue";
import TrashView from "./views/TrashView.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      name: "archive",
      component: ArchiveView,
      meta: { title: "Archive - RecTronic" },
    },
    {
      path: "/schedule",
      name: "schedule",
      component: ScheduleView,
      meta: { title: "Schedule - RecTronic" },
    },
    {
      path: "/watch/:id",
      name: "detail",
      component: RecordingDetail,
      meta: { title: "RecTronic" },
    },
    {
      path: "/trash",
      name: "trash",
      component: TrashView,
      meta: { title: "Trash - RecTronic" },
    },
  ],
});

router.afterEach((to) => {
  const title = typeof to.meta.title === "string" ? to.meta.title : "RecTronic";
  document.title = title;
});

export default router;
