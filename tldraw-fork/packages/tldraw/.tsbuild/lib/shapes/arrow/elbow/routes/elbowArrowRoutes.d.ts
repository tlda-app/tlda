import { ElbowArrowRoute, ElbowArrowSide } from '../definitions';
import { ElbowArrowWorkingInfo } from './ElbowArrowWorkingInfo';
/**
 * Draw one of these arrows:
 *
 * ```
 * 1:              2:         3:          4:          5:
 * ┌───┐           ┌───┐      ┌───┐       ┌───────┐   ┌───────┐ ┌───┐
 * │ A ├─┐         │ A ├─┐    │ A ├───┐   │ ┌───┐ │   │ ┌───┐ │ │ A ├─┐
 * └───┘ │ ┌───┐   └───┘ │    └───┘   │   │ │ A ├─┘   └─► B │ │ └───┘ │
 *       └─► B │    ┌────┘      ┌───┐ │   │ └───┘       └───┘ └───────┘
 *         └───┘    │ ┌───┐   ┌►│ B │ │   │   ┌───┐
 *                  └─► B │   │ └───┘ │   └───► B │
 *                    └───┘   └───────┘       └───┘
 * ```
 */
export declare function routeRightToLeft(info: ElbowArrowWorkingInfo): ElbowArrowRoute | null;
/**
 * Draw one of these arrows:
 * ```
 * 1:              2:              3:
 * ┌───┐                 ┌───┐     ┌───┐
 * │ A ├─────┐     ┌───┐ │ ┌─▼─┐   │ A ├─┐
 * └───┘     │     │ A ├─┘ │ B │   └───┘ │
 *         ┌─▼─┐   └───┘   └───┘     ┌───┘
 *         │ B │                   ┌─▼─┐
 *         └───┘                   │ B │
 *                                 └───┘
 * 4:        5:          6:
 *   ┌───┐     ┌───┐       ┌───┐ ┌───┐
 * ┌─▼─┐ │     │ ┌─▼─┐   ┌─▼─┐ │ │ A ├─┐
 * │ B │ │     │ │ B │   │ B │ │ └───┘ │
 * └───┘ │     │ └───┘   └───┘ └───────┘
 * ┌───┐ │     └───┐
 * │ A ├─┘   ┌───┐ │
 * └───┘     │ A ├─┘
 *           └───┘
 * ```
 */
export declare function routeRightToTop(info: ElbowArrowWorkingInfo): ElbowArrowRoute | null;
/**
 * See `routeRightToTop`.
 */
export declare function routeRightToBottom(info: ElbowArrowWorkingInfo): ElbowArrowRoute | null;
/**
 * Arrows may be mirrored - Y flipped
 * ```
 * 1:        2:                3:
 * ┌───┐     ┌───┐ ┌───────┐           ┌───┐
 * │ A ├─┐   │ A ├─┘ ┌───┐ │   ┌───┐   │ A ├─┐
 * └───┘ │   └───┘   │ B ◄─┘   │ B ◄─┐ └───┘ │
 * ┌───┐ │           └───┘     └───┘ └───────┘
 * │ B ◄─┘
 * └───┘
 * ```
 */
export declare function routeRightToRight(info: ElbowArrowWorkingInfo): ElbowArrowRoute | null;
export declare function tryRouteArrow(info: ElbowArrowWorkingInfo, aEdge: ElbowArrowSide, bEdge: ElbowArrowSide): ElbowArrowRoute | null;
//# sourceMappingURL=elbowArrowRoutes.d.ts.map