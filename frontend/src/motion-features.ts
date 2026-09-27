// Motion feature bundle, loaded after first paint via LazyMotion so the
// initial JS stays small. domMax = animations + gestures + layout and
// shared-layout (layoutId) animations.
import { domMax } from "motion/react";

export default domMax;
