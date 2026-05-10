package com.prodready.social.useraccounts;

import java.util.UUID;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class SignupService {

  private final UserRepository userRepository;
  private final PasswordEncoder passwordEncoder;

  public SignupService(UserRepository userRepository, PasswordEncoder passwordEncoder) {
    this.userRepository = userRepository;
    this.passwordEncoder = passwordEncoder;
  }

  @Transactional
  public UserResponse signup(SignupRequest request) {
    if (userRepository.existsByEmail(request.email())) {
      throw new EmailAlreadyRegisteredException(request.email());
    }
    String hash = passwordEncoder.encode(request.password());
    User user = new User(UUID.randomUUID(), request.email(), hash, request.displayName());
    User saved = userRepository.save(user);
    return UserResponse.fromEntity(saved);
  }
}
