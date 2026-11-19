# Tappi engine: build with cargo, run as a small non-root binary. Never published to the internet.
FROM rust:1-slim-trixie AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY migrations ./migrations
RUN cargo build --release --locked

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 engine
COPY --from=build /src/target/release/tappi-engine /usr/local/bin/tappi-engine
USER engine
ENV ENGINE_ADDR=0.0.0.0:8090
EXPOSE 8090
CMD ["tappi-engine"]
