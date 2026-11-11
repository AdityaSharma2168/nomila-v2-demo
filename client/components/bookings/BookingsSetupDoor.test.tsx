/**
 * BookingsSetupDoor.test — the Me door into Bookings, and the seam into app layout B's Bookings section:
 *
 *   X1 the build flag off: nothing, and no query; bookings off for her (summary null): nothing
 *   X2 the door shows only while nothing is published (once published, Opportunities' section takes over) and never
 *      while Nomila has paused her offers; it opens her offers on the Opportunities tab
 *   X3 layout B's section: rows are plain text without the seam; with onOpen / onSeeAll a row opens her booking and
 *      "See all" opens Bookings
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { BookingsSetupDoor } from "./BookingsSetupDoor";
import { BookingsSection } from "../opps/BusinessSections";
import { summaryFixture } from "../../test/bookingFixtures";

const navigate = jest.fn();
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate, getParent: () => undefined, getState: () => ({ routeNames: ["Tabs", "Brand"] }) }),
}));
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});

const q = (data: any) => ({ data, isLoading: false, isError: false, refetch: jest.fn() });
const summarySpy = jest.fn();
let summary = q(summaryFixture());
jest.mock("../../hooks/use-bookings", () => ({
  useBookingsSummary: (enabled: boolean) => { summarySpy(enabled); return summary; },
}));

const line = (id: string) => ({ id, title: "1:1 video call", format: "video_call", status: "requested", priceCents: 15_000, currency: "usd",
  startsAt: new Date(Date.now() + 48 * 3_600_000).toISOString(), respondBy: new Date(Date.now() + 18 * 3_600_000).toISOString(), createdAt: null });

beforeEach(() => { navigate.mockReset(); summarySpy.mockReset(); summary = q(summaryFixture()); });

describe("X1 off", () => {
  it("the build flag off renders nothing and asks nothing; off for her renders nothing", () => {
    expect(render(<BookingsSetupDoor enabled={false} />).toJSON()).toBeNull();
    expect(summarySpy).not.toHaveBeenCalled();
    summary = q(null);
    expect(render(<BookingsSetupDoor enabled />).toJSON()).toBeNull();
  });
});

describe("X2 the Me door", () => {
  it("only while nothing is published and she isn't paused; it opens her offers on Opportunities", () => {
    expect(render(<BookingsSetupDoor enabled />).toJSON()).toBeNull();
    summary = q(summaryFixture({ showSection: false, pausedByNomila: true }));
    expect(render(<BookingsSetupDoor enabled />).toJSON()).toBeNull();
    summary = q(summaryFixture({ showSection: false, offers: { published: 0, draft: 1, paused: 0 } }));
    render(<BookingsSetupDoor enabled />);
    fireEvent.press(screen.getByTestId("bookings-setup-door"));
    expect(navigate).toHaveBeenCalledWith("Opportunities", { screen: "Bookings", params: { tab: "offers" } });
  });
});

describe("X3 the seam into layout B's section", () => {
  it("rows open her booking and See all opens Bookings, only when wired", () => {
    const a = render(<BookingsSection requests={[line("b1")]} upcoming={[]} />);
    expect(screen.queryByText("See all")).toBeNull();
    expect(screen.getByTestId("booking-row-b1").props.accessibilityRole).toBeUndefined();
    a.unmount();
    const onOpen = jest.fn(), onSeeAll = jest.fn();
    render(<BookingsSection requests={[line("b1")]} upcoming={[line("u1")]} onOpen={onOpen} onSeeAll={onSeeAll} />);
    fireEvent.press(screen.getByTestId("booking-row-u1"));
    expect(onOpen).toHaveBeenCalledWith("u1");
    fireEvent.press(screen.getByText("See all"));
    expect(onSeeAll).toHaveBeenCalled();
  });
});
