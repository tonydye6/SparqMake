import { Router, type IRouter } from "express";
import brandsRouter from "./brands";
import templatesRouter from "./templates";
import assetsRouter from "./assets";
import hashtagSetsRouter from "./hashtag-sets";
import creativesRouter from "./creatives";
import creativeVariantsRouter from "./creative-variants";
import calendarEntriesRouter from "./calendar-entries";
import socialAccountsRouter from "./social-accounts";
import uploadRouter from "./upload";
import generateRouter from "./generate";
import downloadRouter from "./download";
import socialAuthRouter from "./social-auth";
import videoRouter from "./video";
import costLogsRouter from "./cost-logs";
import settingsRouter from "./settings";
import rewriteRouter from "./rewrite";
import conceptSuggestionsRouter from "./concept-suggestions";
import brandAssistRouter from "./brand-assist";
import contentPlanRouter from "./content-plan";
import brandReadinessRouter from "./brand-readiness";
import scheduleProfileRouter from "./schedule-profile";
import smartScheduleRouter from "./smart-schedule";
import feedbackRouter from "./feedback";
import usersRouter from "./users";

const router: IRouter = Router();

router.use(brandsRouter);
router.use(templatesRouter);
router.use(assetsRouter);
router.use(hashtagSetsRouter);
router.use(creativesRouter);
router.use(creativeVariantsRouter);
router.use(calendarEntriesRouter);
router.use(socialAccountsRouter);
router.use(uploadRouter);
router.use(generateRouter);
router.use(downloadRouter);
router.use(socialAuthRouter);
router.use(videoRouter);
router.use(costLogsRouter);
router.use(settingsRouter);
router.use(rewriteRouter);
router.use(conceptSuggestionsRouter);
router.use(brandAssistRouter);
router.use(contentPlanRouter);
router.use(brandReadinessRouter);
router.use(scheduleProfileRouter);
router.use(smartScheduleRouter);
router.use(feedbackRouter);
router.use(usersRouter);

router.all("/{*path}", (_req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

export default router;
