import "@typespec/http";
import "@typespec/openapi";

using Http;
using OpenAPI;

@service(#{ title: "Booking API" })
namespace BookingApi;

model Hold {
  id: string;
  seatId: string;
  customerId: string;
  @minValue(0) priceCents: int32;
  state: "held" | "confirmed" | "released";
  holder?: string;
}

model HoldRequest {
  seatId: string;
  customerId: string;
  @minValue(1) @maxValue(15) holdMinutes: int32;
}

model ConfirmRequest {
  paymentToken: string;
}

@error
model SeatTaken {
  @statusCode _: 409;
  message: string;
}

@error
model PaymentDeclined {
  @statusCode _: 402;
  message: string;
}

@route("/holds")
interface Reservations {
  @extension("x-specbridge-requirements", #["seat-hold/single-seat-hold", "seat-hold/hold-duration"])
  @post holdSeat(@body body: HoldRequest): Hold | SeatTaken;

  @extension("x-specbridge-requirements", #["payment/payment-confirmation"])
  @post @route("{id}/confirm") confirm(@path id: string, @body body: ConfirmRequest): Hold | PaymentDeclined;
}
